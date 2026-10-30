from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, ConfigDict


class AuditEventCreate(BaseModel):
    event_type: str
    drone_id: Optional[int] = None
    details: str
    operator_id: Optional[str] = "SYSTEM"


class AuditEventResponse(BaseModel):
    id: int
    timestamp: datetime
    event_type: str
    drone_id: Optional[int]
    details: str
    operator_id: str
    prev_hash: str
    curr_hash: str
    model_config = ConfigDict(from_attributes=True)


class AARVerificationReport(BaseModel):
    is_valid: bool
    broken_at_index: Optional[int] = None
    total_events: int
    message: str
    first_record_timestamp: Optional[datetime] = None
    latest_record_timestamp: Optional[datetime] = None


class AARExportReport(BaseModel):
    mission_id: str
    generated_at: datetime
    verification: AARVerificationReport
    timeline: List[AuditEventResponse]
    summary: Dict[str, Any]
