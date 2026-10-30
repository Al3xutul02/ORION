from datetime import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field, ConfigDict


class TacticalZoneBase(BaseModel):
    name: str
    zone_type: str = Field(..., description="BASE, SAFE_CORRIDOR, INTERFERENCE, THREAT")
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
