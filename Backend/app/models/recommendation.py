from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Text
from app.core.database import Base


class ActionRecommendation(Base):
    """
    Tactical decision recommendations produced by ORION.
    Blocks unsafe actions (e.g., Return-To-Home crossing an EW zone)
    and proposes verified safe alternatives (e.g., Loiter or Safe Corridor alpha)
    for human-in-the-loop approval.
    """
    __tablename__ = "action_recommendations"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    drone_id = Column(Integer, nullable=False, index=True)
    timestamp = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    
    trigger_event = Column(String(100), nullable=False)
    blocked_action = Column(String(100), nullable=False)   # e.g., "RETURN_TO_HOME"
    blocked_reason = Column(Text, nullable=False)           # e.g., "Direct route crosses EW Interference Zone 1"
    
    recommended_action = Column(String(100), nullable=False) # e.g., "LOITER_THEN_CORRIDOR_ALPHA"
    recommendation_details = Column(Text, nullable=True)     # waypoint list, loiter duration, etc.
    reason = Column(Text, nullable=True)                     # Tactical rationale explaining why this was recommended
    
    status = Column(String(50), default="PENDING")          # PENDING, APPROVED, REJECTED, EXECUTED
    operator_id = Column(String(100), nullable=True)
    approved_at = Column(DateTime, nullable=True)
