from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.aar_service import aar_service
from app.services.copilot_service import CopilotUnavailable
from app.services.radio_service import BadAudio, decode_audio, radio_service
from app.services.simulator import simulator

router = APIRouter(prefix="/radio", tags=["Radio log"])


class Transmission(BaseModel):
    audio_base64: str = Field(..., min_length=1)
    mime_type: str = "audio/webm"
    duration_s: float = Field(..., gt=0, le=90)
    operator_id: str = Field("OPERATOR_1", min_length=1, max_length=64)
    channel: str = Field("COMMAND_NET", max_length=32)
    # When the operator keyed the mic, from the browser clock (ISO 8601).
    started_at: Optional[str] = None
    # Live: write it to the server's AAR log. Demo: the browser keeps its own ledger, just transcribe.
    log: bool = True


class TransmissionOut(BaseModel):
    transcript: str
    language: str
    drones: List[int] = []
    kind: str = "OTHER"
    model: str
    logged: bool
    event_id: Optional[int] = None
    mission_time_s: Optional[float] = None


@router.post("/transmissions", response_model=TransmissionOut)
def post_transmission(payload: Transmission, db: Session = Depends(get_db)):
    """
    Transcribes one push-to-talk transmission (Gemini) and, in Live mode, appends it to the
    hash-chained AAR log as RADIO_TRANSMISSION. The audio itself is not stored.
    """
    try:
        audio, mime = decode_audio(payload.audio_base64, payload.mime_type)
    except BadAudio as e:
        raise HTTPException(status_code=422, detail=str(e))
    try:
        result = radio_service.transcribe(audio, mime)
    except CopilotUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))

    out = TransmissionOut(
        transcript=result["text"], language=result["language"], drones=result["drones"], kind=result["kind"],
        model=result["model"], logged=False,
    )
    if not result["text"] or not payload.log:
        return out  # nothing intelligible was said, or the browser logs it (Demo)

    # Mission time at the moment the mic was keyed, not when the transcript came back.
    mission_time = max(0.0, round(simulator.elapsed_time - payload.duration_s, 1))
    entry = aar_service.log_event(
        db=db,
        event_type="RADIO_TRANSMISSION",
        # One drone named: the record is about it (filters and the per-drone log pick it up).
        drone_id=result["drones"][0] if len(result["drones"]) == 1 else None,
        details={
            "transcript": result["text"],
            "language": result["language"],
            "drones": result["drones"],
            "kind": result["kind"],
            "channel": payload.channel,
            "duration_s": round(payload.duration_s, 1),
            "started_at": payload.started_at,
            "mission_time_s": mission_time,
            "transcribed_by": result["model"],
        },
        operator_id=payload.operator_id,
    )
    out.logged, out.event_id, out.mission_time_s = True, entry.id, mission_time
    return out
