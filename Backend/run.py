import uvicorn
from app.core.config import settings

if __name__ == "__main__":
    print(f"Starting {settings.PROJECT_NAME} v{settings.VERSION} on http://{settings.HOST}:{settings.PORT}")
    print(f"Interactive Swagger Docs available at http://127.0.0.1:{settings.PORT}/docs")
    print(f"WebSocket Telemetry stream at ws://127.0.0.1:{settings.PORT}/ws/telemetry")
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=True if settings.ENVIRONMENT == "development" else False
    )
