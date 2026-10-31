from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Text
from app.core.database import Base


class AuditLog(Base):
    """
    Append-only tamper-evident After-Action Report (AAR) log.
    Every record contains the SHA-256 hash of the previous record,
    forming a cryptographic hash chain. Any tampering breaks the chain.
    """
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    timestamp = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    timestamp_iso = Column(String(40), nullable=False)
    event_type = Column(String(100), nullable=False, index=True)
    drone_id = Column(Integer, nullable=True, index=True)
    details = Column(Text, nullable=False)
    operator_id = Column(String(100), default="SYSTEM")
    
    # Hash Chain Fields
    prev_hash = Column(String(64), nullable=False)
    curr_hash = Column(String(64), nullable=False, unique=True)
