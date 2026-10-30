from datetime import datetime
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field, ConfigDict


class OperatorActionApproval(BaseModel):
    recommendation_id: int
    operator_id: str = "OPERATOR_1"
    decision: str = Field(..., description="'APPROVE' or 'REJECT'")
    notes: Optional[str] = None


class RecommendationResponse(BaseModel):
    id: int
    drone_id: int
    timestamp: datetime
    trigger_event: str
    blocked_action: str
    blocked_reason: str
    recommended_action: str
    recommendation_details: Optional[str]
    status: str
    operator_id: Optional[str]
    approved_at: Optional[datetime]
    model_config = ConfigDict(from_attributes=True)


class SignedCommandDispatch(BaseModel):
    command: str
    drone_id: int
    sequence: int
    params: Dict[str, Any]
    timestamp: float
    signature: str
