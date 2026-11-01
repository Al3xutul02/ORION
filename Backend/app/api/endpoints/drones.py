from pydantic import BaseModel
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.schemas.drone import DroneState, FleetOverview, DroneScoreBreakdown
from app.schemas.telemetry import TelemetryCreate, TelemetryResponse
from app.services.trust_evaluator import trust_evaluator
from app.services.simulator import simulator
from app.models.drone import TelemetryLog
from datetime import datetime, timezone

router = APIRouter(prefix="/drones", tags=["Drones & Fleet"])


@router.get("", response_model=FleetOverview)
def get_fleet_overview():
    """Returns the current state and trust metrics for the entire fleet."""
    drone_states: List[DroneState] = []
    green_count = 0
    yellow_count = 0
    red_count = 0

    fleet_telemetry = [t for d_id in list(simulator.drones.keys()) if (t := simulator.get_telemetry(d_id)) is not None]

    for telem in fleet_telemetry:
        d_id = telem["drone_id"]
        score = trust_evaluator.evaluate(
            drone_id=d_id,
            telemetry=telem,
            peer_telemetries=fleet_telemetry,
            command_valid=True
        )

        if score.trust_status == "GREEN":
            green_count += 1
        elif score.trust_status == "YELLOW":
            yellow_count += 1
        else:
            red_count += 1

        drone_states.append(
            DroneState(
                drone_id=d_id,
                latitude=telem["latitude"],
                longitude=telem["longitude"],
                altitude=telem["altitude"],
                vx=0.0,
                vy=0.0,
                vz=0.0,
                heading=telem["heading"],
                ground_speed=telem["ground_speed"],
                satellites_visible=telem["satellites_visible"],
                fix_type=telem["fix_type"],
                battery_remaining=telem["battery_remaining"],
                drop_rate_comm=telem["drop_rate_comm"],
                rssi=telem["rssi"],
                flight_mode=telem["flight_mode"],
                is_armed=telem["is_armed"],
                trust_score=score.trust_score,
                trust_status=score.trust_status,
                uncertainty_radius_m=score.uncertainty_radius_m,
                reason=score.reason,
                last_updated=datetime.now(timezone.utc)
            )
        )

    return FleetOverview(
        total_drones=len(simulator.drones),
        nominal_green=green_count,
        warning_yellow=yellow_count,
        critical_red=red_count,
        active_sector_interference=trust_evaluator.localized_interference_active,
        drones=drone_states
    )


@router.get("/{drone_id}", response_model=DroneState)
def get_drone_state(drone_id: int):
    """Returns the state and trust details of a specific drone."""
    if drone_id not in simulator.drones:
        raise HTTPException(status_code=404, detail="Drone not found")
    
    fleet = get_fleet_overview()
    for d in fleet.drones:
        if d.drone_id == drone_id:
            return d
    raise HTTPException(status_code=404, detail="Drone not found")


@router.get("/{drone_id}/score", response_model=DroneScoreBreakdown)
def get_drone_score_breakdown(drone_id: int):
    """Returns detailed trust breakdown (GPS, IMU, Link, Consensus) for a drone."""
    if drone_id not in simulator.drones:
        raise HTTPException(status_code=404, detail="Drone not found")

    telem = simulator.get_telemetry(drone_id)
    fleet_telemetry = [simulator.get_telemetry(d_id) for d_id in simulator.drones]
    return trust_evaluator.evaluate(
        drone_id=drone_id,
        telemetry=telem,
        peer_telemetries=fleet_telemetry,
        command_valid=True
    )


@router.post("/telemetry", response_model=TelemetryResponse)
def ingest_telemetry(payload: TelemetryCreate, db: Session = Depends(get_db)):
    """External telemetry ingestion endpoint (e.g., from physical drone or SITL)."""
    entry = TelemetryLog(
        drone_id=payload.drone_id,
        latitude=payload.latitude,
        longitude=payload.longitude,
        altitude=payload.altitude,
        relative_altitude=payload.relative_altitude,
        vx=payload.vx,
        vy=payload.vy,
        vz=payload.vz,
        heading=payload.heading,
        ground_speed=payload.ground_speed,
        fix_type=payload.fix_type,
        satellites_visible=payload.satellites_visible,
        eph=payload.eph,
        battery_remaining=payload.battery_remaining,
        drop_rate_comm=payload.drop_rate_comm,
        rssi=payload.rssi,
        noise=payload.noise,
        flight_mode=payload.flight_mode,
        is_armed=payload.is_armed
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


class DeployDroneRequest(BaseModel):
    operator_id: Optional[str] = "operator_demo"


@router.post("/deploy")
def deploy_drone(payload: Optional[DeployDroneRequest] = None, db: Session = Depends(get_db)):
    """Deploys a new drone in the Base Forward zone."""
    op_id = payload.operator_id if payload and payload.operator_id else "operator_demo"
    res = simulator.deploy_drone(db=db, operator_id=op_id)
    return res
