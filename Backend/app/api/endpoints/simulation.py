from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.services.simulator import simulator

router = APIRouter(prefix="/simulation", tags=["Simulation & Demo"])


@router.post("/start")
async def start_simulation():
    simulator.start()
    return {"status": "started", "elapsed_time": simulator.elapsed_time}


@router.post("/stop")
async def stop_simulation():
    simulator.stop()
    return {"status": "stopped", "elapsed_time": simulator.elapsed_time}


@router.post("/reset")
async def reset_simulation():
    simulator.reset()
    return {"status": "reset", "elapsed_time": 0.0}


@router.post("/trigger-random")
def trigger_random_event(db: Session = Depends(get_db)):
    """Triggers a random battlefield event in Live mode."""
    res = simulator.trigger_random_event(db)
    return {**res, "status": "random_event_triggered"}


@router.post("/trigger-spoofing")
def trigger_spoofing_scenario(db: Session = Depends(get_db)):
    """Triggers GPS spoofing on a patrolling drone."""
    res = simulator.trigger_gps_spoofing_drone2(db)
    return {**res, "status": "spoofing_triggered"}


@router.post("/trigger-replay")
def trigger_replay_attack_scenario(db: Session = Depends(get_db)):
    """Simulates an adversary replaying a previously captured command."""
    res = simulator.trigger_replay_attack(db)
    return {**res, "status": "replay_attack_simulated"}


@router.post("/trigger-sector-interference")
def trigger_sector_interference_scenario(db: Session = Depends(get_db)):
    """Simulates a localized EW jammer affecting nearby drones."""
    res = simulator.trigger_sector_interference(db)
    return {**res, "status": "sector_interference_activated"}


@router.post("/trigger-corridor-appear")
def trigger_corridor_appear_scenario(db: Session = Depends(get_db)):
    """Opens a new safe evacuation corridor in the theatre."""
    res = simulator.trigger_corridor_appear(db)
    return {**res, "status": "safe_corridor_established"}


@router.post("/trigger-corridor-disappear")
def trigger_corridor_disappear_scenario(db: Session = Depends(get_db)):
    """Marks an existing safe corridor as compromised and removes it."""
    res = simulator.trigger_corridor_disappear(db)
    return {**res, "status": "safe_corridor_compromised"}


@router.post("/trigger-danger-appear")
def trigger_danger_appear_scenario(db: Session = Depends(get_db)):
    """Spawns a new danger zone at a random theatre position."""
    res = simulator.trigger_danger_appear(db)
    return {**res, "status": "danger_zone_detected"}


@router.post("/trigger-danger-disappear")
def trigger_danger_disappear_scenario(db: Session = Depends(get_db)):
    """Clears an active danger zone from the theatre."""
    res = simulator.trigger_danger_disappear(db)
    return {**res, "status": "danger_zone_cleared"}


@router.get("/status")
def get_simulation_status():
    return {
        "is_running": simulator.is_running,
        "elapsed_time": round(simulator.elapsed_time, 1),
        "spoofing_active_drone_2": simulator.spoofing_active_drone_2,
        "sector_interference_active": simulator.sector_interference_active,
    }
