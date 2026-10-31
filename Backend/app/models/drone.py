from datetime import datetime, timezone
from sqlalchemy import Column, Integer, Float, String, Boolean, DateTime, Index
from app.core.database import Base


class TelemetryLog(Base):
    __tablename__ = "telemetry_logs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    drone_id = Column(Integer, nullable=False, index=True)
    timestamp = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    
    # Coordinates & Kinematics (GLOBAL_POSITION_INT)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    altitude = Column(Float, nullable=False)
    relative_altitude = Column(Float, default=0.0)
    vx = Column(Float, default=0.0)
    vy = Column(Float, default=0.0)
    vz = Column(Float, default=0.0)
    heading = Column(Float, default=0.0)
    ground_speed = Column(Float, default=0.0)

    # GPS metrics (GPS_RAW_INT)
    fix_type = Column(Integer, default=3)  # 3 = 3D Fix
    satellites_visible = Column(Integer, default=12)
    eph = Column(Float, default=1.0)  # HDOP in meters

    # System & Link metrics (SYS_STATUS & RADIO_STATUS)
    battery_remaining = Column(Float, default=100.0)
    drop_rate_comm = Column(Float, default=0.0)
    rssi = Column(Float, default=100.0)
    noise = Column(Float, default=15.0)

    # Autopilot state (HEARTBEAT)
    flight_mode = Column(String(50), default="GUIDED")
    is_armed = Column(Boolean, default=True)


class DroneScore(Base):
    __tablename__ = "drone_scores"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    drone_id = Column(Integer, nullable=False, index=True)
    timestamp = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)

    # Aggregate trust score: 0 to 100
    trust_score = Column(Float, nullable=False)
    trust_status = Column(String(20), nullable=False, default="GREEN")  # GREEN, YELLOW, RED

    # Sub-component scores (0 to 100)
    gps_score = Column(Float, default=100.0)
    imu_score = Column(Float, default=100.0)          # Concordance between GPS and dead-reckoning
    link_score = Column(Float, default=100.0)         # Comm drop rate & RSSI
    consensus_score = Column(Float, default=100.0)    # Inter-drone neighbor consensus
    command_score = Column(Float, default=100.0)      # MAVLink 2 signature validity

    # Uncertainty circle radius (meters) - expands when trust drops
    uncertainty_radius_m = Column(Float, default=0.0)
    reason = Column(String(512), default="Nominal state")
