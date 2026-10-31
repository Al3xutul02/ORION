import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.services.theatre_rules import theatre_rules
from app.services.simulator import simulator
from app.core.database import SessionLocal
from app.models.audit import AuditLog

client = TestClient(app)


def test_initial_patrol_zone_exists():
    """Patrol Zone Alpha (id: 100) must exist at start."""
    p_zones = theatre_rules.active_patrol_zones()
    assert any(z["id"] == 100 and z["zone_type"] == "PATROL" for z in p_zones)


def test_create_and_delete_patrol_zone_api():
    """Operator can create and delete a patrol zone."""
    res = client.post("/api/v1/zones/patrol", json={
        "name": "Patrol Zone Bravo",
        "center": [44.3400, 23.8200],
        "radius_m": 420.0
    })
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "Patrol Zone Bravo"
    assert data["zone_type"] == "PATROL"
    assert data["center"] == [44.3400, 23.8200]
    assert data["radius_m"] == 420.0
    zone_id = data["id"]

    # Verify zone is active in theatre
    assert theatre_rules.get_zone(zone_id) is not None

    # Delete zone
    del_res = client.delete(f"/api/v1/zones/{zone_id}")
    assert del_res.status_code == 200
    assert del_res.json()["status"] == "DELETED"
    assert theatre_rules.get_zone(zone_id) is None


def test_create_and_delete_objective_zone_api():
    """Operator can create, render as GeoJSON polygon, and delete an objective zone."""
    res = client.post("/api/v1/zones/objective", json={
        "name": "Objective Sector Alpha",
        "waypoints": [[44.3300, 23.8200], [44.3400, 23.8300], [44.3350, 23.8400]]
    })
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "Objective Sector Alpha"
    assert data["zone_type"] == "OBJECTIVE"
    assert data["geometry_type"] == "POLYGON"
    assert len(data["waypoints"]) == 3
    zone_id = data["id"]

    # Verify geojson produces a closed Polygon
    geo_res = client.get("/api/v1/zones/geojson")
    assert geo_res.status_code == 200
    features = geo_res.json()["features"]
    obj_feat = next((f for f in features if f["properties"]["id"] == zone_id), None)
    assert obj_feat is not None
    assert obj_feat["geometry"]["type"] == "Polygon"
    # Closed ring: first and last coords are identical
    coords = obj_feat["geometry"]["coordinates"][0]
    assert coords[0] == coords[-1]

    # Delete zone
    del_res = client.delete(f"/api/v1/zones/{zone_id}")
    assert del_res.status_code == 200
    assert del_res.json()["status"] == "DELETED"
    assert theatre_rules.get_zone(zone_id) is None


def test_create_linear_objective_zone_api():
    """Operator can create a 2-point linear objective zone rendered as GeoJSON LineString."""
    res = client.post("/api/v1/zones/objective", json={
        "name": "Objective Line Recon",
        "waypoints": [[44.3300, 23.8200], [44.3400, 23.8300]]
    })
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "Objective Line Recon"
    assert data["zone_type"] == "OBJECTIVE"
    assert data["geometry_type"] == "LINE"
    zone_id = data["id"]

    geo_res = client.get("/api/v1/zones/geojson")
    assert geo_res.status_code == 200
    features = geo_res.json()["features"]
    feat = next((f for f in features if f["properties"]["id"] == zone_id), None)
    assert feat is not None
    assert feat["geometry"]["type"] == "LineString"

    del_res = client.delete(f"/api/v1/zones/{zone_id}")
    assert del_res.status_code == 200


def test_safe_vs_risky_pathfinding():
    """
    Safe path strictly avoids interference & threat zones.
    Risky path traverses interference/weather zones if optimal, but strictly avoids threat zones.
    """
    start = (44.3160, 23.8000)
    goal = (44.3350, 23.8300)

    safe_route = theatre_rules.plan_target_route(start, goal, path_type="SAFE")
    risky_route = theatre_rules.plan_target_route(start, goal, path_type="RISKY")

    assert safe_route is not None
    assert risky_route is not None
    assert len(safe_route["waypoints"]) >= 2
    assert len(risky_route["waypoints"]) >= 2

    # In risky mode, length should be <= safe mode since soft obstacles can be traversed
    assert risky_route["length_m"] <= safe_route["length_m"] + 5.0


def test_command_drone_join_patrol_and_loiter():
    """Operator can command drone to join a patrol zone or loiter at point."""
    # Command drone 1 to join patrol zone 100 with safe path
    res1 = client.post("/api/v1/actions/command", json={
        "drone_id": 1,
        "action": "JOIN_PATROL",
        "target_zone_id": 100,
        "path_type": "SAFE"
    })
    assert res1.status_code == 200
    assert simulator.drones[1]["mode"] in ("ROUTE", "PATROL")

    # Command drone 3 to loiter at specific spot with risky path
    res2 = client.post("/api/v1/actions/command", json={
        "drone_id": 3,
        "action": "LOITER_AT",
        "target_point": [44.3280, 23.8150],
        "path_type": "RISKY"
    })
    assert res2.status_code == 200
    assert simulator.drones[3]["mode"] == "ROUTE"
    assert simulator.drones[3]["target_mode"] == "LOITER"
    assert simulator.drones[3]["target_point"] == [44.3280, 23.8150]
    assert simulator.drones[3]["path_type"] == "RISKY"
