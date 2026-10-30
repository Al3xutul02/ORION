import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.core.database import Base, engine, SessionLocal
from app.api.api_v1 import api_router
from app.api.websocket.telemetry_ws import router as ws_router
from app.services.simulator import simulator
from app.services.aar_service import aar_service
from app.models.audit import AuditLog

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("orion.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Ensure tables exist
    logger.info("Initializing database schema...")
    try:
        Base.metadata.create_all(bind=engine)
        logger.info("Database schema initialized successfully.")

        # Seed initial genesis log if audit log is completely empty
        with SessionLocal() as db:
            count = db.query(AuditLog).count()
            if count == 0:
                aar_service.log_event(
                    db=db,
                    event_type="SYSTEM_INITIALIZED",
                    drone_id=None,
                    details={"system": "ORION Ground Control Station", "version": settings.VERSION},
                    operator_id="SYSTEM"
                )
                logger.info("AAR genesis event recorded.")
    except Exception as e:
        logger.error("Failed to initialize database schema: %s", e)

    # Start fleet simulator for real-time telemetry feed
    if settings.SIMULATION_DEMO_ENABLED:
        logger.info("Autostarting fleet patrol simulation...")
        simulator.start()

    yield

    # Shutdown
    logger.info("Shutting down ORION GCS...")
    simulator.stop()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description=(
        "ORION Ground Control Station for drone fleets operating in Electronic Warfare (EW) environments. "
        "Provides real-time multi-signal trust scoring, inter-drone consensus, zone-aware tactical action "
        "validation, MAVLink 2 command signing, and an inviolable hash-chained After-Action Report (AAR)."
    ),
    lifespan=lifespan
)

# CORS configuration for Frontend (Angular / MapLibre GL)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include Routers
app.include_router(api_router, prefix=settings.API_V1_STR)
app.include_router(ws_router)


@app.get("/", tags=["System"])
def root():
    return {
        "project": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "status": "OPERATIONAL",
        "docs_url": "/docs",
        "openapi_url": "/openapi.json",
        "websocket_url": "/ws/telemetry",
        "api_v1_prefix": settings.API_V1_STR
    }


@app.get("/health", tags=["System"])
def health_check():
    return {
        "status": "healthy",
        "simulator_running": simulator.is_running,
        "simulation_time_s": simulator.elapsed_time
    }
