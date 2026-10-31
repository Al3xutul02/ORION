from datetime import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field, ConfigDict


class TacticalZoneBase(BaseModel):
    name: str
    zone_type: str = Field(..., description="BASE, SAFE_CORRIDOR, INTERFERENCE, THREAT, PATROL")
    geometry_type: str = Field("POLYGON", description="POLYGON or CIRCLE")
    coordinates_json: str
    is_active: bool = True
    detected_by: str = "PRECONFIGURED"


class TacticalZoneCreate(TacticalZoneBase):
    pass


class TacticalZoneResponse(TacticalZoneBase):
    id: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class TacticalZoneGeoJSON(BaseModel):
    type: str = "FeatureCollection"
    features: List[Dict[str, Any]]


class CreatePatrolZoneRequest(BaseModel):
    name: Optional[str] = None
    center: List[float] = Field(..., description="[lat, lon]")
    radius_m: float = Field(..., gt=0)


class CreateThreatZoneRequest(BaseModel):
    name: Optional[str] = None
    center: Optional[List[float]] = Field(None, description="[lat, lon]")
    radius_m: Optional[float] = Field(None, gt=0)
    waypoints: Optional[List[List[float]]] = Field(None, min_length=3, description="List of [lat, lon] polygon vertices")


class CreateSafeCorridorRequest(BaseModel):
    name: Optional[str] = None
    waypoints: List[List[float]] = Field(..., min_length=2, description="List of [lat, lon]")


class CreateObjectiveZoneRequest(BaseModel):
    name: Optional[str] = None
    waypoints: List[List[float]] = Field(..., min_length=2, description="List of [lat, lon] coordinates (line or polygon)")


class ExecuteZoneTacticRequest(BaseModel):
    zone_id: int
    tactic: str = Field(..., description="SECTOR_ORBIT_SHIFT, TIGHT_MESH, WIDE_RECON, EGRESS_CORRIDOR, RESYNC_EQUIDISTANT")
