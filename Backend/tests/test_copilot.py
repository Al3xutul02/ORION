from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors, types

from app.services.copilot_service import copilot_service

EVENTS = [
    {"id": 1, "timestamp": "2026-10-30T18:00:00Z", "event_type": "SYSTEM_INITIALIZED", "drone_id": None,
     "details": '{"mission_time_s": 0}', "operator_id": "SYSTEM"},
    {"id": 2, "timestamp": "2026-10-30T18:01:00Z", "event_type": "RECOMMENDATION_ISSUED", "drone_id": 2,
     "details": '{"blocked_action": "RETURN_TO_HOME", "mission_time_s": 60}', "operator_id": "ORION_THEATRE_RULES"},
]


class FakeModels:
    """Stands in for client.models and records what the copilot sent."""

    def __init__(self, text="", finish_reason=types.FinishReason.STOP, block_reason=None, error=None):
        self.text, self.finish_reason, self.block_reason, self.error, self.calls = text, finish_reason, block_reason, error, []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(
            text=self.text,
            model_version=kwargs["model"],
            candidates=[SimpleNamespace(finish_reason=self.finish_reason)],
            prompt_feedback=SimpleNamespace(block_reason=self.block_reason) if self.block_reason else None,
        )


@pytest.fixture
def fake_gemini(monkeypatch):
    def install(**kwargs):
        models = FakeModels(**kwargs)
        monkeypatch.setattr(copilot_service, "_client", SimpleNamespace(models=models))
        return models
    return install


def ask(client, **extra):
    body = {"question": "Why was RTL blocked?", "events": EVENTS, "chain_valid": True, **extra}
    return client.post("/api/v1/copilot/ask", json=body)


def context_of(call):
    return call["config"].system_instruction[1]


def test_answers_from_client_ledger_and_keeps_only_real_citations(client, fake_gemini):
    fake = fake_gemini(text="RTL was blocked for Drone 2 [#2]. Something else [#99].")
    res = ask(client)
    assert res.status_code == 200
    data = res.json()
    assert data["cited_ids"] == [2]  # #99 is not in the log, so it is not a citation
    assert data["source"] == "client" and data["chain_valid"] is True and data["records"] == 2

    sent = fake.calls[0]
    assert not sent["config"].tools  # read-only: the model is given no tools
    context = context_of(sent)
    assert "#2 | T+1:00" in context and "RECOMMENDATION_ISSUED" in context
    last = sent["contents"][-1]
    assert last.role == "user" and last.parts[0].text == "Why was RTL blocked?"


def test_history_is_trimmed_to_start_with_a_user_turn(client, fake_gemini):
    fake = fake_gemini(text="ok")
    history = [{"role": "assistant", "content": "hi"}, {"role": "user", "content": "q1"}, {"role": "assistant", "content": "a1"}]
    ask(client, history=history)
    roles = [c.role for c in fake.calls[0]["contents"]]
    assert roles == ["user", "model", "user"]  # Gemini calls the assistant "model"


def test_reports_a_broken_chain_to_the_model(client, fake_gemini):
    fake = fake_gemini(text="ok")
    ask(client, chain_valid=False)
    assert "BROKEN" in context_of(fake.calls[0])


@pytest.mark.parametrize("blocked", [
    {"finish_reason": types.FinishReason.SAFETY},
    {"block_reason": types.BlockedReason.PROHIBITED_CONTENT},
])
def test_refusal_is_returned_as_such(client, fake_gemini, blocked):
    fake_gemini(text="", **blocked)
    data = ask(client).json()
    assert data["refused"] is True and data["cited_ids"] == []


def test_invalid_key_gives_a_clear_503(client, fake_gemini):
    # What Gemini answers for a wrong key: 400 INVALID_ARGUMENT, "API key not valid".
    fake_gemini(error=errors.ClientError(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}}))
    res = ask(client)
    assert res.status_code == 503
    assert "GEMINI_API_KEY" in res.json()["detail"]


def test_no_key_at_all_gives_a_clear_503(client, monkeypatch):
    monkeypatch.setattr(copilot_service, "_client", None)
    monkeypatch.setattr("app.services.copilot_service.settings.GEMINI_API_KEY", None)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    res = ask(client)
    assert res.status_code == 503
    assert "GEMINI_API_KEY" in res.json()["detail"]


@pytest.mark.parametrize("error, expected", [
    (errors.ClientError(429, {"error": {"code": 429, "message": "Resource exhausted", "status": "RESOURCE_EXHAUSTED"}}), "rate limited"),
    (errors.ClientError(404, {"error": {"code": 404, "message": "models/x is not found", "status": "NOT_FOUND"}}), "COPILOT_MODEL"),
    (errors.ServerError(503, {"error": {"code": 503, "message": "overloaded", "status": "UNAVAILABLE"}}), "Gemini API error (503)"),
    (httpx.ConnectError("no route"), "no internet"),
])
def test_api_failures_become_readable_503s(client, fake_gemini, error, expected):
    fake_gemini(error=error)
    res = ask(client)
    assert res.status_code == 503 and expected in res.json()["detail"]


def test_server_ledger_is_used_when_no_events_are_sent(client, fake_gemini):
    fake = fake_gemini(text="ok")
    res = client.post("/api/v1/copilot/ask", json={"question": "What happened?"})
    assert res.status_code == 200
    assert res.json()["source"] == "server"
    assert "<aar_log>" in context_of(fake.calls[0])
