import json
from types import SimpleNamespace

import pytest
from google.genai import errors, types

from app.services.copilot_service import copilot_service
from app.services.training_service import sanitize_move

STATE = {
    "elapsed_s": 42.0,
    "remaining_s": 138.0,
    "available": ["SPOOF", "JAMMER", "LINK_LOSS", "REPLAY", "STORM"],
    "eligible": {"SPOOF": [1, 3, 4], "LINK_LOSS": [5, 6]},
    "drones": [{"id": 2, "status": "RED", "mode": "LOITER"}],
    "pending_decisions": [{"drone_id": 2, "action": "LOITER", "waiting_s": 18}],
    "operator": {"decisions": 1, "avg_reaction_s": 31},
    "history": [{"at_s": 12, "move": "SPOOF", "target": 2}],
}

RESULTS = {
    "score": 64,
    "duration_s": 180,
    "decisions": [{"drone_id": 2, "action": "LOITER", "reaction_s": 40, "outcome": "APPROVED"}],
    "red_seconds": {"2": 55},
    "attacks": [{"at_s": 12, "move": "SPOOF", "target": 2, "reason": "Testez reacția la spoofing."}],
}


class FakeModels:
    def __init__(self, payload, error=None):
        self.payload, self.error, self.calls = payload, error, []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(
            text=json.dumps(self.payload), model_version=kwargs["model"],
            candidates=[SimpleNamespace(finish_reason=types.FinishReason.STOP)], prompt_feedback=None,
        )


@pytest.fixture
def fake_gemini(monkeypatch):
    def install(payload, error=None):
        models = FakeModels(payload, error)
        monkeypatch.setattr(copilot_service, "_client", SimpleNamespace(models=models))
        return models
    return install


def test_adversary_move_is_asked_as_json_with_the_exercise_state(client, fake_gemini):
    fake = fake_gemini({"move": "SPOOF", "target_drone": 3, "wait_s": 20, "reason": "Operatorul e lent: mai pun presiune."})
    res = client.post("/api/v1/training/adversary-move", json=STATE)
    assert res.status_code == 200
    assert res.json() | {"model": None} == {"move": "SPOOF", "target_drone": 3, "wait_s": 20, "reason": "Operatorul e lent: mai pun presiune.", "model": None}
    config = fake.calls[0]["config"]
    assert config.response_mime_type == "application/json" and config.response_json_schema["required"]
    assert not config.tools  # it picks a simulated event; it is given nothing it could call
    assert json.loads(fake.calls[0]["contents"])["pending_decisions"][0]["waiting_s"] == 18


@pytest.mark.parametrize("raw, expected", [
    # Target the sim can't spoof (drone 2 is already spoofed): retargeted to an eligible drone.
    ({"move": "SPOOF", "target_drone": 2, "wait_s": 20, "reason": "x"}, ("SPOOF", 1)),
    # A move the sim can't stage right now (the jammer is busy, say) becomes a wait.
    ({"move": "WIND", "target_drone": None, "wait_s": 20, "reason": "x"}, ("WAIT", None)),
    # Untargeted moves never carry a target.
    ({"move": "JAMMER", "target_drone": 4, "wait_s": 20, "reason": "x"}, ("JAMMER", None)),
    # Garbage becomes a wait.
    ({"move": "NUKE", "wait_s": 5}, ("WAIT", None)),
])
def test_moves_are_kept_within_what_the_simulator_can_do(raw, expected):
    move = sanitize_move(raw, STATE)
    assert (move.move, move.target_drone) == expected
    assert 12 <= move.wait_s <= 40


def test_wait_is_clamped_so_the_operator_has_time_to_react():
    assert sanitize_move({"move": "REPLAY", "target_drone": None, "wait_s": 2, "reason": "x"}, STATE).wait_s == 12
    assert sanitize_move({"move": "REPLAY", "target_drone": None, "wait_s": 400, "reason": "x"}, STATE).wait_s == 40


def test_debrief_is_written_from_the_measured_results(client, fake_gemini):
    fake = fake_gemini({
        "summary": "Sesiune solidă, dar decizia pentru D2 a întârziat.",
        "strengths": ["Ai respins corect comanda reluată."],
        "improvements": ["Ai aprobat loiter pentru D2 în 40 s; ținta este sub 10 s."],
    })
    res = client.post("/api/v1/training/debrief", json=RESULTS)
    assert res.status_code == 200
    assert "40 s" in res.json()["improvements"][0]
    sent = json.loads(fake.calls[0]["contents"])
    assert sent["decisions"][0]["reaction_s"] == 40 and sent["score"] == 64


def test_unavailable_ai_gives_503_so_the_browser_plays_locally(client, fake_gemini):
    fake_gemini(None, error=errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}}))
    assert client.post("/api/v1/training/adversary-move", json=STATE).status_code == 503
    assert client.post("/api/v1/training/debrief", json=RESULTS).status_code == 503


def test_unreadable_answer_gives_503(client, monkeypatch):
    bad = SimpleNamespace(models=SimpleNamespace(generate_content=lambda **k: SimpleNamespace(
        text="not json", model_version="m", candidates=[SimpleNamespace(finish_reason=types.FinishReason.STOP)], prompt_feedback=None)))
    monkeypatch.setattr(copilot_service, "_client", bad)
    assert client.post("/api/v1/training/adversary-move", json=STATE).status_code == 503


def test_adversary_uses_the_fast_model_without_waiting_on_the_main_one(client, fake_gemini):
    from app.core.config import settings
    fake = fake_gemini({"move": "REPLAY", "target_drone": None, "wait_s": 20, "reason": "x"})
    client.post("/api/v1/training/adversary-move", json=STATE)
    assert [c["model"] for c in fake.calls] == [settings.TRAINING_ADVERSARY_MODEL]
