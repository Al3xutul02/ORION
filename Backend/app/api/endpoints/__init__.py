from app.api.endpoints.drones import router as drones_router
from app.api.endpoints.zones import router as zones_router
from app.api.endpoints.actions import router as actions_router
from app.api.endpoints.aar import router as aar_router
from app.api.endpoints.simulation import router as simulation_router
from app.api.endpoints.copilot import router as copilot_router
from app.api.endpoints.training import router as training_router
from app.api.endpoints.mavlink import router as mavlink_router

__all__ = [
    "drones_router",
    "zones_router",
    "actions_router",
    "aar_router",
    "simulation_router",
    "copilot_router",
    "training_router",
    "mavlink_router",
]
