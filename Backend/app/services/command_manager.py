import logging
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session
from app.models.recommendation import ActionRecommendation
from app.core.security import command_signer
from app.services.aar_service import aar_service
from app.services.mavlink_parser import mavlink_parser

logger = logging.getLogger("orion.commands")


class CommandManager:
    """
    Handles Operator human-in-the-loop decisions, MAVLink 2 command signing,
    and anti-replay verification with cryptographic AAR logging.
    """

    def __init__(self):
        self._command_sequence = 100

    def create_recommendation(
        self,
        db: Session,
        drone_id: int,
        trigger_event: str,
        blocked_action: str,
        blocked_reason: str,
        recommended_action: str,
        details: Optional[str] = None,
        reason: Optional[str] = None
    ) -> ActionRecommendation:
        rec = ActionRecommendation(
            drone_id=drone_id,
            trigger_event=trigger_event,
            blocked_action=blocked_action,
            blocked_reason=blocked_reason,
            recommended_action=recommended_action,
            recommendation_details=details,
            reason=reason,
            status="PENDING"
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)

        # Log recommendation generation to AAR
        aar_service.log_event(
            db=db,
            event_type="RECOMMENDATION_ISSUED",
            drone_id=drone_id,
            details={
                "recommendation_id": rec.id,
                "blocked_action": blocked_action,
                "blocked_reason": blocked_reason,
                "recommended_action": recommended_action,
                "reason": reason
            },
            operator_id="SYSTEM"
        )
        return rec

    def handle_operator_decision(
        self,
        db: Session,
        recommendation_id: int,
        operator_id: str,
        decision: str,  # "APPROVE" or "REJECT"
        notes: Optional[str] = None
    ) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        rec = db.query(ActionRecommendation).filter(ActionRecommendation.id == recommendation_id).first()
        if not rec:
            return False, "Recommendation not found", None

        if rec.status != "PENDING":
            return False, f"Recommendation already processed (status: {rec.status})", None

        rec.operator_id = operator_id
        rec.approved_at = datetime.now(timezone.utc)

        if decision.upper() == "APPROVE":
            rec.status = "APPROVED"
            db.commit()

            # Sign MAVLink 2 command
            self._command_sequence += 1
            cmd_payload = command_signer.sign_command(
                command_name=rec.recommended_action,
                drone_id=rec.drone_id,
                sequence=self._command_sequence,
                params={"recommendation_id": rec.id, "notes": notes or ""}
            )

            # Log to AAR
            aar_service.log_event(
                db=db,
                event_type="OPERATOR_APPROVAL",
                drone_id=rec.drone_id,
                details={
                    "recommendation_id": rec.id,
                    "approved_action": rec.recommended_action,
                    "command_sequence": self._command_sequence,
                    "signature": cmd_payload["signature"],
                    "notes": notes
                },
                operator_id=operator_id
            )

            return True, f"Operator approved {rec.recommended_action}. Command signed and dispatched.", cmd_payload

        else:
            rec.status = "REJECTED"
            db.commit()

            # Log rejection to AAR
            aar_service.log_event(
                db=db,
                event_type="OPERATOR_REJECTION",
                drone_id=rec.drone_id,
                details={
                    "recommendation_id": rec.id,
                    "rejected_action": rec.recommended_action,
                    "notes": notes
                },
                operator_id=operator_id
            )

            return True, "Operator rejected recommendation.", None

    def receive_and_validate_command(
        self,
        db: Session,
        command_data: Dict[str, Any],
        operator_id: str = "INCOMING_UPLINK"
    ) -> Tuple[bool, str]:
        """
        Validates incoming commands against signature and replay attacks.
        Replayed or invalid commands are rejected and recorded into the inviolable AAR log.
        """
        is_valid, reason = command_signer.verify_command(command_data)
        drone_id = command_data.get("drone_id")

        if not is_valid:
            event_type = "COMMAND_REPLAY_REJECTED" if "Replay" in reason else "COMMAND_AUTH_FAILED"
            aar_service.log_event(
                db=db,
                event_type=event_type,
                drone_id=drone_id,
                details={
                    "rejection_reason": reason,
                    "command_payload": command_data
                },
                operator_id=operator_id
            )
            return False, reason

        aar_service.log_event(
            db=db,
            event_type="COMMAND_EXECUTED",
            drone_id=drone_id,
            details={
                "command": command_data.get("command"),
                "sequence": command_data.get("sequence"),
                "status": "AUTHENTICATED"
            },
            operator_id=operator_id
        )
        return True, reason


command_manager = CommandManager()
