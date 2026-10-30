from fastapi import APIRouter
from app.api.endpoints import (
    drones_router,
    zones_router,
    actions_router,
    aar_router,
    simulation_router,
    copilot_router
)

api_router = APIRouter()
api_router.include_router(drones_router)
api_router.include_router(zones_router)
api_router.include_router(actions_router)
api_router.include_router(aar_router)
api_router.include_router(simulation_router)
api_router.include_router(copilot_router)
