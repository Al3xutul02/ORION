from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.schemas.audit import AuditEventResponse, AARVerificationReport, AARExportReport
from app.services.aar_service import aar_service

router = APIRouter(prefix="/aar", tags=["Inviolable Post-Action Report (AAR)"])


@router.get("/events", response_model=List[AuditEventResponse])
def get_audit_events(limit: int = 2000, db: Session = Depends(get_db)):
    """Retrieves chronological entries from the tamper-evident hash-chained AAR log."""
    return aar_service.get_events(db=db, limit=limit)


@router.get("/verify", response_model=AARVerificationReport)
def verify_hash_chain(db: Session = Depends(get_db)):
    """
    Cryptographically verifies the SHA-256 hash chain from genesis to latest record.
    Returns whether the ledger is mathematically intact or if any record was tampered with.
    """
    return aar_service.verify_audit_chain(db=db)


@router.get("/export", response_model=AARExportReport)
def export_post_action_report(mission_id: str = "ORION-MISSION-2026", db: Session = Depends(get_db)):
    """Exports full post-action report with timeline, decisions, and hash chain proof."""
    return aar_service.export_report(db=db, mission_id=mission_id)
