from fastapi import APIRouter

from app.services.mavlink_bridge import mavlink_input, mavlink_output

router = APIRouter(prefix="/mavlink", tags=["MAVLink bridge (QGroundControl / SITL)"])


@router.get("/status")
def mavlink_status():
    """Where ORION publishes its drones as MAVLink, and which external vehicles it currently hears."""
    return {"output": mavlink_output.status(), "input": mavlink_input.status()}
