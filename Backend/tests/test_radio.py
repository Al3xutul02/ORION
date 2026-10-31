import base64
import json
from types import SimpleNamespace

import pytest
from google.genai import errors, types

from app.services.copilot_service import SYSTEM_PROMPT, copilot_service, format_records

AUDIO = base64.b64encode(b"\x1aE\xdf\xa3fake-webm-opus").decode()


def body(**over):
    return {"audio_base64": AUDIO, "mime_type": "audio/webm;codecs=opus", "duration_s": 3.2,
            "started_at": "2026-10-31T12:00:00Z", **over}


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


def test_transmission_is_transcribed_and_hash_chained(client, fake_gemini):
    fake = fake_gemini({"text": "Pierd GPS pe D3 și D4, pare bruiaj.", "language": "ro"})
    res = client.post("/api/v1/radio/transmissions", json=body())
    assert res.status_code == 200
    out = res.json()
    assert out["transcript"] == "Pierd GPS pe D3 și D4, pare bruiaj." and out["logged"] and out["event_id"]

    # The audio went to Gemini as audio, with its plain MIME type.
    part = fake.calls[0]["contents"][0]
    assert part.inline_data.mime_type == "audio/webm" and part.inline_data.data.startswith(b"\x1aE")

    events = client.get("/api/v1/aar/events").json()
    radio = next(e for e in events if e["id"] == out["event_id"])
    assert radio["event_type"] == "RADIO_TRANSMISSION" and radio["operator_id"] == "OPERATOR_1"
    details = json.loads(radio["details"])
    assert details["transcript"].startswith("Pierd GPS") and details["duration_s"] == 3.2
    assert "audio" not in json.dumps(details).lower().replace("audio/", "")  # text only, never the recording
    assert client.get("/api/v1/aar/verify").json()["is_valid"]


def test_demo_mode_only_transcribes(client, fake_gemini):
    fake_gemini({"text": "D5 nu mai răspunde.", "language": "ro"})
    before = len(client.get("/api/v1/aar/events").json())
    out = client.post("/api/v1/radio/transmissions", json=body(log=False)).json()
    assert out["transcript"] == "D5 nu mai răspunde." and not out["logged"]
    assert len(client.get("/api/v1/aar/events").json()) == before


def test_silence_is_not_logged(client, fake_gemini):
    fake_gemini({"text": "", "language": ""})
    before = len(client.get("/api/v1/aar/events").json())
    out = client.post("/api/v1/radio/transmissions", json=body()).json()
    assert out["transcript"] == "" and not out["logged"]
    assert len(client.get("/api/v1/aar/events").json()) == before


@pytest.mark.parametrize("over, detail", [
    ({"mime_type": "video/mp4"}, "Unsupported audio type"),
    ({"audio_base64": "not base64!!"}, "base64"),
    ({"audio_base64": base64.b64encode(b"x" * (3 * 1024 * 1024 + 1)).decode()}, "too long"),
])
def test_bad_uploads_are_rejected_before_gemini(client, fake_gemini, over, detail):
    fake = fake_gemini({"text": "x", "language": "ro"})
    res = client.post("/api/v1/radio/transmissions", json=body(**over))
    assert res.status_code == 422 and detail in res.json()["detail"]
    assert not fake.calls


def test_unavailable_gemini_gives_503(client, fake_gemini):
    fake_gemini(None, error=errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}}))
    assert client.post("/api/v1/radio/transmissions", json=body()).status_code == 503


def test_copilot_sees_transcripts_with_speaker_and_time():
    line = format_records([{
        "id": 43, "timestamp": "2026-10-31T12:01:52Z", "event_type": "RADIO_TRANSMISSION", "drone_id": None,
        "details": json.dumps({"transcript": "pierd GPS pe D3 și D4", "mission_time_s": 112}), "operator_id": "OPERATOR_1",
    }])
    assert "#43 | T+1:52" in line and "RADIO_TRANSMISSION" in line and "by OPERATOR_1" in line and "pierd GPS pe D3 și D4" in line
    assert "RADIO_TRANSMISSION" in SYSTEM_PROMPT and "[#43]" in SYSTEM_PROMPT


def test_concurrent_writers_do_not_fork_the_chain(client, monkeypatch):
    """An approval, a radio transmission and the simulator can all log at the same instant."""
    import sys
    import time
    from concurrent.futures import ThreadPoolExecutor
    from app.core.database import SessionLocal
    from app.services.aar_service import aar_service

    aar = sys.modules["app.services.aar_service"]  # the module, not the aar_service instance

    # Widen the gap between reading the last hash and inserting, as a slow DB would.
    real_hash = aar.calculate_event_hash
    monkeypatch.setattr(aar, "calculate_event_hash", lambda **kw: (time.sleep(0.005), real_hash(**kw))[1])

    def write(i):
        db = SessionLocal()
        try:
            aar_service.log_event(db=db, event_type="TEST_CONCURRENT", drone_id=None, details={"i": i})
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(write, range(40)))
    assert client.get("/api/v1/aar/verify").json()["is_valid"]
