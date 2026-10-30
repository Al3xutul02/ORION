from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text
from app.core.database import Base


class TacticalZone(Base):
    """
    Tactical zone definition:
    - BASE: Home base safe area
    - SAFE_CORRIDOR: Established clear corridors for retreat/navigation
    - INTERFERENCE: Active EW / GPS spoofing/jamming zones (preconfigured or dynamically identified by ORION)
    - THREAT: Restricted or hazardous zones
    """
    __tablename__ = "tactical_zones"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    zone_type = Column(String(50), nullable=False, index=True)  # BASE, SAFE_CORRIDOR, INTERFERENCE, THREAT
    geometry_type = Column(String(20), default="POLYGON")       # POLYGON or CIRCLE
    
    # Coordinates in JSON:
    # For CIRCLE: {"center": [lat, lon], "radius_m": float}
    # For POLYGON: {"coordinates": [[[lat, lon], [lat, lon], ...]]}
    coordinates_json = Column(Text, nullable=False)
    
    is_active = Column(Boolean, default=True)
    detected_by = Column(String(50), default="PRECONFIGURED")  # PRECONFIGURED or ORION_CONSENSUS
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
