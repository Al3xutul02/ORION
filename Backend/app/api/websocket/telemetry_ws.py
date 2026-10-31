import json
import logging
from typing import Set
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.simulator import simulator

logger = logging.getLogger("orion.websocket")

router = APIRouter()


class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info("WebSocket client connected. Total clients: %d", len(self.active_connections))

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
        logger.info("WebSocket client disconnected. Total clients: %d", len(self.active_connections))

    async def broadcast(self, message: dict):
        if not self.active_connections:
            return
        dead = []
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)
        for d in dead:
            self.disconnect(d)


manager = ConnectionManager()

# Hook simulator broadcasts to WebSocket manager
simulator.subscribe(manager.broadcast)


@router.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial snapshot immediately upon connection
        from app.services.theatre_rules import theatre_rules
        await websocket.send_json({
            "type": "SNAPSHOT",
            "message": "Connected to ORION Ground Control Station Telemetry Stream",
            "zones": theatre_rules.zones,
            "simulator_running": simulator.is_running,
            "elapsed_time": simulator.elapsed_time
        })
        while True:
            # Keep receiving or process client heartbeat/commands
            data = await websocket.receive_text()
            try:
                parsed = json.loads(data)
                if parsed.get("action") == "PING":
                    await websocket.send_json({"type": "PONG"})
            except Exception:
                pass
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.warning("WebSocket error: %s", e)
        manager.disconnect(websocket)
