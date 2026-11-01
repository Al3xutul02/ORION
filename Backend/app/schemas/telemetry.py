from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict


class TelemetryBase(BaseModel):
    drone_id: int
    latitude: float
    longitude: float
    altitude: float
    relative_altitude: float = 0.0
    vx: float = 0.0
    vy: float = 0.0
    vz: float = 0.0
    heading: float = 0.0
    ground_speed: float = 0.0
    fix_type: int = 3
    satellites_visible: int = 12
    eph: float = 1.0
    battery_remaining: float = 100.0
    drop_rate_comm: float = 0.0
    rssi: float = 100.0
    noise: float = 15.0
    flight_mode: str = "GUIDED"
    is_armed: bool = True
    patrol_zone_id: Optional[int] = None
    target_waypoints: Optional[List[List[float]]] = None
    eta_s: Optional[int] = None


class TelemetryCreate(TelemetryBase):
    pass


class TelemetryResponse(TelemetryBase):
    id: int
    timestamp: datetime
    model_config = ConfigDict(from_attributes=True)


class MAVLinkHeartbeatMsg(BaseModel):
    type: int = 2  # MAV_TYPE_QUADROTOR
    autopilot: int = 3  # MAV_AUTOPILOT_ARDUPILOTMEGA
    base_mode: int = 0
    custom_mode: int = 0
    system_status: int = 4  # MAV_STATE_ACTIVE
    mavlink_version: int = 2


class MAVLinkGPSRawIntMsg(BaseModel):
    time_usec: int = 0
    fix_type: int = 3  # 0-1: no fix, 2: 2D, 3: 3D
    lat: int = 0       # Latitude (WGS84, 1e7)
    lon: int = 0       # Longitude (WGS84, 1e7)
    alt: int = 0       # Altitude (MSL, 1e3 mm)
    eph: int = 100     # GPS HDOP horizontal dilution of position in cm (100 = 1.0m)
    epv: int = 100
    vel: int = 0
    cog: int = 0
    satellites_visible: int = 12


class MAVLinkGlobalPositionIntMsg(BaseModel):
    time_boot_ms: int = 0
    lat: int = 0       # 1e7
    lon: int = 0       # 1e7
    alt: int = 0       # mm MSL
    relative_alt: int = 0 # mm above ground
    vx: int = 0        # cm/s
    vy: int = 0        # cm/s
    vz: int = 0        # cm/s
    hdg: int = 0       # cdeg


class MAVLinkSysStatusMsg(BaseModel):
    drop_rate_comm: int = 0 # 100% * 10000
    errors_comm: int = 0
    battery_remaining: int = 100 # percentage (0..100)


class MAVLinkRadioStatusMsg(BaseModel):
    rssi: int = 200    # 0..255
    remrssi: int = 200
    txbuf: int = 100
    noise: int = 25
    remnoise: int = 25
    rxerrors: int = 0
    fixed: int = 0
