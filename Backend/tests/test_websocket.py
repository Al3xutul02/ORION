import json
import time

from app.services.simulator import simulator


def test_fleet_update_broadcast_is_json_serialisable(client):
    """
    Every simulator broadcast goes out through WebSocket.send_json. If the payload holds
    anything json can't encode (e.g. a datetime), the send fails and the connection manager
    silently drops every client after the initial snapshot.
    """
    captured = []
    simulator.subscribe(captured.append)
    try:
        deadline = time.time() + 5
        while not captured and time.time() < deadline:
            time.sleep(0.1)
    finally:
        simulator.unsubscribe(captured.append)

    assert captured, "simulator produced no broadcast within 5 s"
    update = captured[0]
    assert update["type"] == "FLEET_UPDATE"
    assert len(update["drones"]) == 4
    json.dumps(update)  # raises TypeError on a non-serialisable field
