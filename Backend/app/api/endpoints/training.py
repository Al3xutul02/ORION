from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Depends
from app.models.user import User
from app.api.endpoints.auth import require_operator
from pydantic import BaseModel, Field

from app.services.copilot_service import CopilotUnavailable
from app.services.training_service import training_service

router = APIRouter(prefix="/training", tags=["AI operator training (Demo)"])


class ExerciseState(BaseModel):
    """What the in-browser exercise looks like now, sent by the Demo simulator."""
    elapsed_s: float
    remaining_s: float
    available: List[str]
    eligible: Dict[str, List[int]] = {}
    drones: List[Dict[str, Any]] = []
    pending_decisions: List[Dict[str, Any]] = []
    operator: Dict[str, Any] = {}
    history: List[Dict[str, Any]] = []


class MoveOut(BaseModel):
    move: str
    target_drone: Optional[int]
    wait_s: int
    reason: str
    model: str


class SessionResults(BaseModel):
    score: int
    duration_s: float
    decisions: List[Dict[str, Any]] = []
    red_seconds: Dict[str, float] = {}
    attacks: List[Dict[str, Any]] = []
    extra: Dict[str, Any] = Field(default_factory=dict)


class DebriefOut(BaseModel):
    summary: str
    strengths: List[str]
    improvements: List[str]
    model: str


@router.post("/adversary-move", response_model=MoveOut)
def adversary_move(state: ExerciseState, current_user: User = Depends(require_operator)):
    """Gemini, as the simulated opposing force, picks the next training event. 503 = play the local adversary."""
    try:
        return training_service.next_move(state.model_dump())
    except CopilotUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/debrief", response_model=DebriefOut)
def debrief(results: SessionResults, current_user: User = Depends(require_operator)):
    """Instructor feedback written from the session's measured results. 503 = use the local debrief."""
    try:
        return training_service.debrief(results.model_dump())
    except CopilotUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
