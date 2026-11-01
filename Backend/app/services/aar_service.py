import json
import logging
import threading
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session
from app.models.audit import AuditLog
from app.core.security import GENESIS_HASH, calculate_event_hash, verify_hash_chain
from app.schemas.audit import AARVerificationReport, AARExportReport, AuditEventResponse

logger = logging.getLogger("orion.aar")

# Request threads (approvals, commands, radio) and the simulator loop all append to the chain.
# Reading the last hash and inserting the next record must be one step, or two writers link to
# the same predecessor and fork the chain.
_append_lock = threading.Lock()


class AARService:
    """
    Inviolable Post-Action Report (AAR) Service.
    Appends events to a tamper-evident SHA-256 hash-chained ledger and verifies chain integrity.
    """

    def log_event(
        self,
        db: Session,
        event_type: str,
        drone_id: Optional[int],
        details: Dict[str, Any] | str,
        operator_id: str = "SYSTEM"
    ) -> AuditLog:
        """
        Appends a new event into the audit log linked to the preceding entry's cryptographic hash.
        """
        with _append_lock:
            return self._append(db, event_type, drone_id, details, operator_id)

    def _append(
        self, db: Session, event_type: str, drone_id: Optional[int], details: Dict[str, Any] | str, operator_id: str,
    ) -> AuditLog:
        now = datetime.now(timezone.utc)
        now_iso = now.isoformat()
        details_str = json.dumps(details, sort_keys=True) if isinstance(details, dict) else str(details)

        # Get latest record to find previous hash
        latest_record = db.query(AuditLog).order_by(AuditLog.id.desc()).first()
        prev_hash = latest_record.curr_hash if latest_record else GENESIS_HASH

        # Calculate new hash linking to previous entry
        curr_hash = calculate_event_hash(
            prev_hash=prev_hash,
            timestamp=now_iso,
            event_type=event_type,
            drone_id=drone_id,
            details=details_str,
            operator_id=operator_id
        )

        entry = AuditLog(
            timestamp=now,
            timestamp_iso=now_iso,
            event_type=event_type,
            drone_id=drone_id,
            details=details_str,
            operator_id=operator_id,
            prev_hash=prev_hash,
            curr_hash=curr_hash
        )

        db.add(entry)
        db.commit()
        db.refresh(entry)

        logger.info(
            "AAR event logged: [%s] Drone:%s, Operator:%s (Hash: %s...)",
            event_type, drone_id, operator_id, curr_hash[:8]
        )
        return entry

    def get_events(self, db: Session, limit: int = 2000) -> List[AuditLog]:
        recent = db.query(AuditLog).order_by(AuditLog.id.desc()).limit(limit).all()
        return list(reversed(recent))

    def verify_audit_chain(self, db: Session) -> AARVerificationReport:
        records = db.query(AuditLog).order_by(AuditLog.id.asc()).all()
        if not records:
            return AARVerificationReport(
                is_valid=True,
                broken_at_index=None,
                total_events=0,
                message="AAR Log is clean (0 records)."
            )

        dict_records = []
        for r in records:
            dict_records.append({
                "id": r.id,
                "timestamp": r.timestamp_iso or r.timestamp.isoformat(),
                "event_type": r.event_type,
                "drone_id": r.drone_id,
                "details": r.details,
                "operator_id": r.operator_id,
                "prev_hash": r.prev_hash,
                "curr_hash": r.curr_hash
            })

        is_valid, broken_idx, msg = verify_hash_chain(dict_records)

        return AARVerificationReport(
            is_valid=is_valid,
            broken_at_index=broken_idx,
            total_events=len(records),
            message=msg,
            first_record_timestamp=records[0].timestamp if records else None,
            latest_record_timestamp=records[-1].timestamp if records else None
        )

    def export_report(self, db: Session, mission_id: str = "ORION-MISSION-2026") -> AARExportReport:
        verification = self.verify_audit_chain(db)
        records = db.query(AuditLog).order_by(AuditLog.id.asc()).all()

        timeline = [AuditEventResponse.model_validate(r) for r in records]

        event_counts: Dict[str, int] = {}
        affected_drones: set[int] = set()
        for r in records:
            event_counts[r.event_type] = event_counts.get(r.event_type, 0) + 1
            if r.drone_id:
                affected_drones.add(r.drone_id)

        summary = {
            "total_events": len(records),
            "event_breakdown": event_counts,
            "drones_involved": sorted(list(affected_drones)),
            "integrity_status": "VERIFIED_SECURE" if verification.is_valid else "TAMPERED_COMPROMISED"
        }

        return AARExportReport(
            mission_id=mission_id,
            generated_at=datetime.now(timezone.utc),
            verification=verification,
            timeline=timeline,
            summary=summary
        )


aar_service = AARService()
