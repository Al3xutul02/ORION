"""
AI-driven operator training (Demo mode): Gemini plays the opposing force and, at the end, writes
the debrief.

The adversary only ever picks from a fixed menu of simulated events that the in-browser Demo
simulator can stage (GPS spoofing, a mobile jammer, a command-link loss, a replayed command,
weather). It cannot reach the drones or the command path: the browser applies the move to its
own simulation. Whatever the model answers is validated against what the browser said is
possible right now, so a bad answer degrades to "wait", never to something the sim can't do.
"""
import json
import logging
from typing import Any, Dict, List, Literal, Optional

from google.genai import types
from pydantic import BaseModel, Field, ValidationError

from app.core.config import settings
from app.services.copilot_service import CopilotUnavailable, copilot_service, is_blocked

logger = logging.getLogger("orion.training")

Move = Literal["SPOOF", "JAMMER", "LINK_LOSS", "REPLAY", "STORM", "WIND", "RAIN", "WAIT"]
TARGETED = {"SPOOF", "LINK_LOSS"}
MIN_WAIT_S, MAX_WAIT_S = 12, 40

ADVERSARY_PROMPT = """You are the opposing force (OPFOR) in a simulated, defensive training exercise for drone ground-control operators. Nothing here is real: every move you choose is a scripted event inside a training simulator, and its purpose is to train the human operator.

Each turn you get the current exercise state and choose ONE next event from the "available" list, or WAIT. Good training pressure:
- Probe the operator's weak spots: if they are slow to decide, add pressure while a decision is still pending; if they are fast, try a different kind of event.
- Vary the events across the session; don't repeat the same move twice in a row unless it clearly tests a weakness.
- Leave the operator time to react: choose wait_s (seconds until your next turn) between 12 and 40.
- SPOOF and LINK_LOSS need target_drone, chosen from "eligible" for that move. Other moves take target_drone = null. At most two drones can be spoofed at once; when "eligible" has none, spoofing isn't possible right now.
- Keep "reason" to one short sentence in Romanian, written for the instructor's debrief (it is hidden from the operator until the end).
Answer only with the JSON object."""

ADVERSARY_SCHEMA = {
    "type": "object",
    "properties": {
        "move": {"type": "string", "enum": list(Move.__args__)},
        "target_drone": {"type": ["integer", "null"]},
        "wait_s": {"type": "integer", "minimum": MIN_WAIT_S, "maximum": MAX_WAIT_S},
        "reason": {"type": "string"},
    },
    "required": ["move", "target_drone", "wait_s", "reason"],
}

DEBRIEF_PROMPT = """You are the instructor debriefing a drone ground-control operator after a simulated, defensive training exercise.

You get the measured results of the session: every decision the operator had to take with how long it took, the time drones spent in red, the events the opposing force staged (with its reasons) and the session score. Write the debrief in Romanian:
- "summary": 2-3 sentences on how the session went overall.
- "strengths": 1-3 concrete things done well.
- "improvements": 1-3 concrete things to improve, each with the measured number and the target, e.g. "Ai aprobat retragerea pentru D2 în 40 s; ținta este sub 15 s."
Use only the numbers given. Never invent events, times or drones. Be direct and constructive, like a good instructor. Answer only with the JSON object."""

DEBRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "improvements": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "strengths", "improvements"],
}


class AdversaryMove(BaseModel):
    move: Move
    target_drone: Optional[int] = None
    wait_s: int = 20
    reason: str = ""


class Debrief(BaseModel):
    summary: str
    strengths: List[str] = Field(default_factory=list)
    improvements: List[str] = Field(default_factory=list)


def _json_call(
    prompt: str, schema: Dict[str, Any], payload: Dict[str, Any], models: Optional[List[str]] = None,
) -> tuple[Dict[str, Any], str]:
    response = copilot_service.generate(
        json.dumps(payload, ensure_ascii=False),
        types.GenerateContentConfig(
            system_instruction=prompt,
            response_mime_type="application/json",
            response_json_schema=schema,
            max_output_tokens=2000,
            thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
        ),
        models,
    )
    if is_blocked(response):
        raise CopilotUnavailable("The model declined this request.")
    try:
        data = json.loads(response.text or "")
    except ValueError as e:
        raise CopilotUnavailable("The model returned an unreadable answer.") from e
    if not isinstance(data, dict):
        raise CopilotUnavailable("The model returned an unreadable answer.")
    return data, response.model_version or ""


def sanitize_move(raw: Dict[str, Any], state: Dict[str, Any]) -> AdversaryMove:
    """Keeps the model's move only if the simulator can stage it right now."""
    try:
        move = AdversaryMove(**raw)
    except ValidationError:
        return AdversaryMove(move="WAIT", wait_s=15, reason="Răspuns invalid de la model: adversarul așteaptă.")
    available = set(state.get("available") or [])
    eligible = state.get("eligible") or {}
    move.wait_s = max(MIN_WAIT_S, min(MAX_WAIT_S, move.wait_s))
    move.reason = move.reason.strip()[:300]
    if move.move != "WAIT" and move.move not in available:
        return AdversaryMove(move="WAIT", wait_s=move.wait_s, reason=f"{move.move} nu era disponibil: adversarul așteaptă.")
    if move.move in TARGETED:
        targets = [int(t) for t in eligible.get(move.move, [])]
        if not targets:
            return AdversaryMove(move="WAIT", wait_s=move.wait_s, reason=f"Nicio țintă posibilă pentru {move.move}.")
        if move.target_drone not in targets:
            move.target_drone = targets[0]
    else:
        move.target_drone = None
    return move


class TrainingService:
    def next_move(self, state: Dict[str, Any]) -> Dict[str, Any]:
        # A turn has to come back within seconds, mid-exercise: a fast model, no fallback chain.
        raw, model = _json_call(ADVERSARY_PROMPT, ADVERSARY_SCHEMA, state, [settings.TRAINING_ADVERSARY_MODEL])
        move = sanitize_move(raw, state)
        return {**move.model_dump(), "model": model}

    def debrief(self, results: Dict[str, Any]) -> Dict[str, Any]:
        raw, model = _json_call(DEBRIEF_PROMPT, DEBRIEF_SCHEMA, results)
        try:
            debrief = Debrief(**raw)
        except ValidationError as e:
            raise CopilotUnavailable("The model returned an unreadable debrief.") from e
        return {**debrief.model_dump(), "model": model}


training_service = TrainingService()
