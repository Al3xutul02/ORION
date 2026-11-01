import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.services.simulator import simulator

client = TestClient(app)


def test_login_operator_success():
    res = client.post("/api/v1/auth/login", json={"username": "operator_demo", "password": "123"})
    assert res.status_code == 200
    data = res.json()
    assert data["username"] == "operator_demo"
    assert data["role"] == "OPERATOR"
    assert data["displayName"] == "Operator Demo"
    assert "token" in data


def test_login_commander_success():
    res = client.post("/api/v1/auth/login", json={"username": "commander_demo", "password": "123"})
    assert res.status_code == 200
    data = res.json()
    assert data["username"] == "commander_demo"
    assert data["role"] == "COMMANDER"
    assert data["displayName"] == "Commander Demo"
    assert "token" in data


def test_login_invalid_password():
    res = client.post("/api/v1/auth/login", json={"username": "operator_demo", "password": "wrongpassword"})
    assert res.status_code == 401
    assert "Invalid username or password" in res.json()["detail"]


def test_login_unknown_user():
    res = client.post("/api/v1/auth/login", json={"username": "non_existent", "password": "123"})
    assert res.status_code == 401


def test_list_demo_users():
    res = client.get("/api/v1/auth/users")
    assert res.status_code == 200
    users = res.json()
    assert len(users) >= 2
    usernames = [u["username"] for u in users]
    assert "operator_demo" in usernames
    assert "commander_demo" in usernames


def test_deploy_drone_attribution():
    try:
        res = client.post("/api/v1/drones/deploy", json={"operator_id": "operator_demo"})
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "DRONE_DEPLOYED"
        drone_id = data["drone_id"]
        assert drone_id in simulator.drones
    finally:
        # Clean up deployed drone so it doesn't affect other tests
        if 5 in simulator.drones:
            del simulator.drones[5]
        simulator._next_drone_id = 5


def test_zone_patrol_attribution():
    res = client.post("/api/v1/zones/patrol", json={
        "name": "Test Auth Patrol",
        "center": [44.33, 23.79],
        "radius_m": 1200.0,
        "operator_id": "operator_demo"
    })
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "Test Auth Patrol"
