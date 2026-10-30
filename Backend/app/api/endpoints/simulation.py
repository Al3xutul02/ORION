from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.services.simulator import simulator

router = APIRouter(prefix="/simulation", tags=["Demo Simulation & Attacks"])


@router.post("/start")
def start_simulation():
    """Starts the 4-drone patrol simulation."""
    simulator.start()
    return {"status": "RUNNING", "message": "Simulation started."}


@router.post("/stop")
def stop_simulation():
    """Stops the simulation."""
    simulator.stop()
    return {"status": "STOPPED", "message": "Simulation stopped."}


@router.post("/reset")
def reset_simulation():
    """Resets simulator to t=0s nominal patrol."""
    simulator.reset()
    return {"status": "RESET", "message": "Simulation reset to t=0."}


@router.post("/trigger-spoofing")
def trigger_spoofing(db: Session = Depends(get_db)):
    """Triggers GPS spoofing attack on Drone 2 (teleportation jump & degraded GPS)."""
    simulator.trigger_gps_spoofing_drone2(db)
    return {"status": "ATTACK_TRIGGERED", "target": "Drone 2", "type": "GPS_SPOOFING"}


@router.post("/trigger-replay")
def trigger_replay_attack(db: Session = Depends(get_db)):
    """Simulates an unauthorized adversary retransmitting an old signed MAVLink command."""
    simulator.trigger_replay_attack(db)
    return {"status": "ATTACK_TRIGGERED", "type": "COMMAND_REPLAY", "message": "Replayed command dispatched to validator."}


@router.post("/trigger-sector-interference")
def trigger_sector_interference(db: Session = Depends(get_db)):
    """Triggers localized EW interference affecting Drone 1 & Drone 3."""
    simulator.trigger_sector_interference(db)
    return {"status": "ATTACK_TRIGGERED", "type": "SECTOR_INTERFERENCE"}


@router.get("/status")
def get_simulation_status():
    """Returns simulator running state, elapsed time, and reached milestones."""
    return {
        "is_running": simulator.is_running,
        "elapsed_time": simulator.elapsed_time,
        "milestones": simulator.milestones_reached
    }
