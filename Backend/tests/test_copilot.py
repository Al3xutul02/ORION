from types import SimpleNamespace

import anthropic
import httpx2
import pytest

from app.services.copilot_service import copilot_service

EVENTS = [
    {"id": 1, "timestamp": "2026-10-30T18:00:00Z", "event_type": "SYSTEM_INITIALIZED", "drone_id": None,
     "details": '{"mission_time_s": 0}', "operator_id": "SYSTEM"},
    {"id": 2, "timestamp": "2026-10-30T18:01:00Z", "event_type": "RECOMMENDATION_ISSUED", "drone_id": 2,
     "details": '{"blocked_action": "RETURN_TO_HOME", "mission_time_s": 60}', "operator_id": "ORION_THEATRE_RULES"},
]


class FakeMessages:
    """Stands in for client.beta.messages and records what the copilot sent."""

    def __init__(self, text="", stop_reason="end_turn", error=None):
        self.text, self.stop_reason, self.error, self.calls = text, stop_reason, error, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            model=kwargs["model"],
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=self.text)],
        )


@pytest.fixture
def fake_claude(monkeypatch):
    def install(**kwargs):
        messages = FakeMessages(**kwargs)
        monkeypatch.setattr(copilot_service, "_client", SimpleNamespace(beta=SimpleNamespace(messages=messages)))
        return messages
    return install


def ask(client, **extra):
    body = {"question": "Why was RTL blocked?", "events": EVENTS, "chain_valid": True, **extra}
    return client.post("/api/v1/copilot/ask", json=body)


def test_answers_from_client_ledger_and_keeps_only_real_citations(client, fake_claude):
    fake = fake_claude(text="RTL was blocked for Drone 2 [#2]. Something else [#99].")
    res = ask(client)
    assert res.status_code == 200
    data = res.json()
    assert data["cited_ids"] == [2]  # #99 is not in the log, so it is not a citation
    assert data["source"] == "client" and data["chain_valid"] is True and data["records"] == 2

    sent = fake.calls[0]
    assert "tools" not in sent  # read-only: the model is given no tools
    assert sent["fallbacks"] == "default"
    context = sent["system"][1]["text"]
    assert "#2 | T+1:00" in context and "RECOMMENDATION_ISSUED" in context
    assert sent["messages"][-1] == {"role": "user", "content": "Why was RTL blocked?"}


def test_history_is_trimmed_to_start_with_a_user_turn(client, fake_claude):
    fake = fake_claude(text="ok")
    history = [{"role": "assistant", "content": "hi"}, {"role": "user", "content": "q1"}, {"role": "assistant", "content": "a1"}]
    ask(client, history=history)
    roles = [m["role"] for m in fake.calls[0]["messages"]]
    assert roles == ["user", "assistant", "user"]


def test_reports_a_broken_chain_to_the_model(client, fake_claude):
    fake = fake_claude(text="ok")
    ask(client, chain_valid=False)
    assert "BROKEN" in fake.calls[0]["system"][1]["text"]


def test_refusal_is_returned_as_such(client, fake_claude):
    fake_claude(text="", stop_reason="refusal")
    data = ask(client).json()
    assert data["refused"] is True and data["cited_ids"] == []


def test_missing_credentials_give_a_clear_503(client, fake_claude):
    response = httpx2.Response(401, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
    fake_claude(error=anthropic.AuthenticationError("invalid x-api-key", response=response, body=None))
    res = ask(client)
    assert res.status_code == 503
    assert "ANTHROPIC_API_KEY" in res.json()["detail"]


def test_no_credentials_at_all_give_a_clear_503(client, fake_claude):
    # What the SDK raises when neither a key nor a profile is available.
    fake_claude(error=TypeError('"Could not resolve authentication method. Expected one of api_key..."'))
    res = ask(client)
    assert res.status_code == 503
    assert "ANTHROPIC_API_KEY" in res.json()["detail"]


def test_server_ledger_is_used_when_no_events_are_sent(client, fake_claude):
    fake = fake_claude(text="ok")
    res = client.post("/api/v1/copilot/ask", json={"question": "What happened?"})
    assert res.status_code == 200
    assert res.json()["source"] == "server"
    assert "<aar_log>" in fake.calls[0]["system"][1]["text"]
