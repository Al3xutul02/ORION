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


def test_config_random_interval(client):
    res = client.post("/api/v1/simulation/config-random-interval", json={"min_s": 4.0, "max_s": 8.0, "enabled": False})
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "configured"
    assert data["random_interval_min"] == 4.0
    assert data["random_interval_max"] == 8.0
    assert data["random_events_enabled"] is False

    st = client.get("/api/v1/simulation/status")
    assert st.status_code == 200
    assert st.json()["random_interval_min"] == 4.0
    assert st.json()["random_interval_max"] == 8.0
    assert st.json()["random_events_enabled"] is False

    # Test toggling random events endpoint
    t_res = client.post("/api/v1/simulation/toggle-random-events", json={"enabled": True})
    assert t_res.status_code == 200
    assert t_res.json()["random_events_enabled"] is True

    t_toggle = client.post("/api/v1/simulation/toggle-random-events")
    assert t_toggle.status_code == 200
    assert t_toggle.json()["random_events_enabled"] is False

    bad = client.post("/api/v1/simulation/config-random-interval", json={"min_s": 10.0, "max_s": 2.0})
    assert bad.status_code == 400


def test_deploy_drone_and_retreat_disappearance(client):
    # Reset simulation first
    assert client.post("/api/v1/simulation/reset").status_code == 200

    # 1. Deploy drone via POST /api/v1/drones/deploy
    r = client.post("/api/v1/drones/deploy")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "DRONE_DEPLOYED"
    assert data["drone_id"] == 5
    assert data["mode"] == "LOITER"

    # Verify fleet count increased to 5
    f = client.get("/api/v1/drones").json()
    assert f["total_drones"] == 5
    d5 = next(d for d in f["drones"] if d["drone_id"] == 5)
    assert d5["flight_mode"] == "LOITER"

    # Also test /api/v1/simulation/deploy-drone
    r2 = client.post("/api/v1/simulation/deploy-drone")
    assert r2.status_code == 200
    assert r2.json()["drone_id"] == 6

    # Verify drone 6 exists in fleet
    f2 = client.get("/api/v1/drones").json()
    assert f2["total_drones"] == 6

    # 2. Test retreat completion causes drone to disappear
    # Set drone 6 in RTL directly adjacent to its base waypoint so it reaches it immediately
    from app.services.simulator import simulator
    from app.services.theatre_rules import theatre_rules
    from app.core.database import SessionLocal

    base_lat = theatre_rules.home_base["lat"]
    base_lon = theatre_rules.home_base["lon"]
    simulator.drones[6]["mode"] = "RTL"
    simulator.drones[6]["egress_waypoints"] = [[base_lat, base_lon]]
    simulator.drones[6]["lat"] = base_lat
    simulator.drones[6]["lon"] = base_lon

    with SessionLocal() as db:
        simulator._move_drone(db, 6, simulator.drones[6], 1.0)

    # Drone 6 should have disappeared
    assert 6 not in simulator.drones
    f3 = client.get("/api/v1/drones").json()
    assert f3["total_drones"] == 5
    assert not any(d["drone_id"] == 6 for d in f3["drones"])

    # Reset simulation back to initial state for subsequent tests
    assert client.post("/api/v1/simulation/reset").status_code == 200
    assert client.post("/api/v1/simulation/start").status_code == 200
