import pytest


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"


def test_get_fleet(client):
    response = client.get("/api/v1/drones")
    assert response.status_code == 200
    data = response.json()
    assert data["total_drones"] == 4
    assert len(data["drones"]) == 4


def test_get_zones(client):
    response = client.get("/api/v1/zones")
    assert response.status_code == 200
    zones = response.json()
    assert len(zones) >= 4


def test_get_zones_geojson(client):
    response = client.get("/api/v1/zones/geojson")
    assert response.status_code == 200
    geojson = response.json()
    assert geojson["type"] == "FeatureCollection"
    assert len(geojson["features"]) >= 4


def test_live_battlefield_events_and_commands(client):
    # Reset simulation first
    assert client.post("/api/v1/simulation/reset").status_code == 200

    # 1. Trigger a new safe corridor appearing
    r = client.post("/api/v1/simulation/trigger-corridor-appear")
    assert r.status_code == 200
    assert r.json()["status"] == "safe_corridor_established"

    # 2. Trigger a safe corridor disappearing
    r = client.post("/api/v1/simulation/trigger-corridor-disappear")
    assert r.status_code == 200
    assert r.json()["status"] == "safe_corridor_compromised"

    # 3. Trigger a new danger zone appearing
    r = client.post("/api/v1/simulation/trigger-danger-appear")
    assert r.status_code == 200
    assert r.json()["status"] == "danger_zone_detected"

    # 4. Trigger an old danger zone disappearing
    r = client.post("/api/v1/simulation/trigger-danger-disappear")
    assert r.status_code == 200
    assert r.json()["status"] == "danger_zone_cleared"

    # 5. Trigger mobile EW jammer
    r = client.post("/api/v1/simulation/trigger-sector-interference")
    assert r.status_code == 200
    assert r.json()["status"] == "sector_interference_activated"

    # 6. Trigger GPS spoofing
    r = client.post("/api/v1/simulation/trigger-spoofing")
    assert r.status_code == 200
    assert r.json()["status"] == "spoofing_triggered"

    # 7. Trigger random battlefield event
    r = client.post("/api/v1/simulation/trigger-random")
    assert r.status_code == 200

    # 8. Send direct signed command to a drone in Live mode
    r = client.post(
        "/api/v1/actions/command",
        json={
            "drone_id": 1,
            "action": "LOITER",
            "operator_id": "OP_TEST",
            "notes": "Hold position during EW threat",
        },
    )
    assert r.status_code == 200
    assert r.json()["status"] == "COMMAND_SENT"
    assert r.json()["signed_command"]["command"] == "LOITER"

    # 9. Verify simulation status endpoint
    r = client.get("/api/v1/simulation/status")
    assert r.status_code == 200
    assert "is_running" in r.json()
    assert "spoofing_active_drone_2" in r.json()

    # Restart simulation so subsequent websocket tests see active broadcasts
    assert client.post("/api/v1/simulation/start").status_code == 200


def test_aar_verify(client):
    response = client.get("/api/v1/aar/verify")
    assert response.status_code == 200
    report = response.json()
    assert report["is_valid"] is True
