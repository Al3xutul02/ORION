from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, ConfigDict


class DroneScoreBreakdown(BaseModel):
    drone_id: int
    trust_score: float
    trust_status: str  # "GREEN", "YELLOW", "RED"
    gps_score: float
    imu_score: float
    link_score: float
    consensus_score: float
    command_score: float
    uncertainty_radius_m: float
    reason: str
    timestamp: datetime
    model_config = ConfigDict(from_attributes=True)


class DroneState(BaseModel):
    drone_id: int
    latitude: float
    longitude: float
    altitude: float
    vx: float
    vy: float
    vz: float
    heading: float
    ground_speed: float
    satellites_visible: int
    fix_type: int
    battery_remaining: float
    drop_rate_comm: float
    rssi: float
    flight_mode: str
    is_armed: bool
    
    # Security & Trust
    trust_score: float
    trust_status: str
    uncertainty_radius_m: float
    reason: str
    patrol_zone_id: Optional[int] = None
    target_waypoints: Optional[List[List[float]]] = None
    eta_s: Optional[int] = None
    last_updated: datetime


class FleetOverview(BaseModel):
    total_drones: int
    nominal_green: int
    warning_yellow: int
    critical_red: int
    active_sector_interference: bool
    drones: List[DroneState]
