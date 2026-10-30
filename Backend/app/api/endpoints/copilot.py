from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.aar_service import aar_service
from app.services.copilot_service import CopilotUnavailable, copilot_service

router = APIRouter(prefix="/copilot", tags=["Read-only AAR Copilot"])


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ClientEvent(BaseModel):
    id: int
    timestamp: str
    event_type: str
    drone_id: Optional[int] = None
    details: str
    operator_id: str = "SYSTEM"


class CopilotQuestion(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    history: List[ChatTurn] = []
    # Offline (in-browser) scenario: the frontend sends its own ledger and its verification
    # result. Omit both to answer from the server's hash-chained audit log.
    events: Optional[List[ClientEvent]] = None
    chain_valid: Optional[bool] = None
    fleet: Optional[List[Dict[str, Any]]] = None
    elapsed_s: Optional[float] = None


class CopilotAnswer(BaseModel):
    answer: str
    cited_ids: List[int]
    refused: bool
    model: str
    source: Literal["server", "client"]
    chain_valid: bool
    records: int


@router.post("/ask", response_model=CopilotAnswer)
def ask_copilot(payload: CopilotQuestion, db: Session = Depends(get_db)):
    """
    Answers a question about the mission from the after-action log only, citing record ids.
    Read-only: it has no tools, sends no commands and writes nothing.
    """
    if payload.events is not None:
        source = "client"
        events = [e.model_dump() for e in payload.events]
        chain_valid = bool(payload.chain_valid)
    else:
        source = "server"
        verification = aar_service.verify_audit_chain(db=db)
        chain_valid = verification.is_valid
        events = [
            {
                "id": r.id,
                "timestamp": (r.timestamp_iso or r.timestamp.isoformat()),
                "event_type": r.event_type,
                "drone_id": r.drone_id,
                "details": r.details,
                "operator_id": r.operator_id,
            }
            for r in aar_service.get_events(db=db, limit=1000)
        ]

    try:
        result = copilot_service.ask(
            question=payload.question,
            events=events,
            chain_valid=chain_valid,
            history=[t.model_dump() for t in payload.history],
            fleet=payload.fleet,
            elapsed_s=payload.elapsed_s,
        )
    except CopilotUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))

    return CopilotAnswer(**result, source=source, chain_valid=chain_valid, records=len(events))
