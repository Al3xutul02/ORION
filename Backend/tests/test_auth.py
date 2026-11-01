import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.database import SessionLocal
from app.models.user import User
from app.models.audit import AuditLog
from app.core.security import create_access_token, verify_password
from app.services.simulator import simulator

client = TestClient(app)


def test_database_persistence_and_password_hash():
    """Verify users are stored in the database table with salted PBKDF2 hashes, not plaintext."""
    with SessionLocal() as db:
        users = db.query(User).all()
        assert len(users) >= 2
        usernames = {u.username: u for u in users}
        assert "operator_demo" in usernames
        assert "commander_demo" in usernames

        op = usernames["operator_demo"]
        assert op.role == "OPERATOR"
        assert op.password_hash != "123"  # Must NOT be stored in plain text
        assert len(op.password_hash) == 64  # SHA-256 hex digest length
        assert len(op.salt) > 0
        assert verify_password("123", op.password_hash, op.salt) is True

        cmd = usernames["commander_demo"]
        assert cmd.role == "COMMANDER"
        assert cmd.password_hash != "123"
        assert verify_password("123", cmd.password_hash, cmd.salt) is True


def test_login_operator_success():
    res = client.post("/api/v1/auth/login", json={"username": "operator_demo", "password": "123"})
    assert res.status_code == 200
    data = res.json()
    assert data["username"] == "operator_demo"
    assert data["role"] == "OPERATOR"
    assert data["displayName"] == "Operator Demo"
    assert "token" in data
    assert len(data["token"].split(".")) == 3  # Standard 3-part signed token


def test_login_commander_success():
    res = client.post("/api/v1/auth/login", json={"username": "commander_demo", "password": "123"})
    assert res.status_code == 200
    data = res.json()
    assert data["username"] == "commander_demo"
    assert data["role"] == "COMMANDER"
    assert data["displayName"] == "Commander Demo"
    assert "token" in data
    assert len(data["token"].split(".")) == 3


def test_login_invalid_password():
    res = client.post("/api/v1/auth/login", json={"username": "operator_demo", "password": "wrongpassword"})
    assert res.status_code == 401
    assert "Invalid username or password" in res.json()["detail"]


def test_login_unknown_user():
    res = client.post("/api/v1/auth/login", json={"username": "non_existent", "password": "123"})
    assert res.status_code == 401


def test_list_demo_users_no_leaks():
    res = client.get("/api/v1/auth/users")
    assert res.status_code == 200
    users = res.json()
    assert len(users) >= 2
    for u in users:
        assert "username" in u
        assert "role" in u
        assert "displayName" in u
        assert "password" not in u
        assert "password_hash" not in u
        assert "salt" not in u


def test_get_me_endpoint():
    op_token = create_access_token("operator_demo", "OPERATOR")
    res = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {op_token}"})
    assert res.status_code == 200
    data = res.json()
    assert data["username"] == "operator_demo"
    assert data["role"] == "OPERATOR"


def test_unauthenticated_request_rejected():
    """Mutating operational requests without auth header return 401."""
    res = client.post("/api/v1/drones/deploy")
    assert res.status_code == 401
    assert "Authentication token is missing" in res.json()["detail"]


def test_tampered_token_rejected():
    """Tampering with token payload or signature returns 401."""
    token = create_access_token("operator_demo", "OPERATOR")
    header_b64, payload_b64, sig_b64 = token.split(".")
    # Tamper with the signature
    tampered_sig = sig_b64[:-3] + "xyz"
    tampered_token = f"{header_b64}.{payload_b64}.{tampered_sig}"

    res = client.post("/api/v1/drones/deploy", headers={"Authorization": f"Bearer {tampered_token}"})
    assert res.status_code == 401
    assert "Invalid or tampered authentication token" in res.json()["detail"]


def test_operator_cannot_create_commander_zones():
    """Operators are forbidden from creating safe corridors, threat zones, or objective zones (403)."""
    op_token = create_access_token("operator_demo", "OPERATOR")
    headers = {"Authorization": f"Bearer {op_token}"}

    # Threat zone
    r1 = client.post("/api/v1/zones/threat", headers=headers, json={
        "name": "Operator Threat Attempt",
        "center": [44.33, 23.79],
        "radius_m": 500.0
    })
    assert r1.status_code == 403
    assert "Commander access required" in r1.json()["detail"]

    # Safe corridor
    r2 = client.post("/api/v1/zones/corridor", headers=headers, json={
        "name": "Operator Corridor Attempt",
        "waypoints": [[44.33, 23.79], [44.34, 23.80]]
    })
    assert r2.status_code == 403
    assert "Commander access required" in r2.json()["detail"]

    # Objective zone
    r3 = client.post("/api/v1/zones/objective", headers=headers, json={
        "name": "Operator Objective Attempt",
        "waypoints": [[44.33, 23.79], [44.34, 23.80], [44.35, 23.79]]
    })
    assert r3.status_code == 403
    assert "Commander access required" in r3.json()["detail"]


def test_commander_cannot_execute_operator_actions():
    """Commanders are forbidden from deploying drones, direct control, patrol zones, or AI training (403)."""
    cmd_token = create_access_token("commander_demo", "COMMANDER")
    headers = {"Authorization": f"Bearer {cmd_token}"}

    # Deploy drone
    r1 = client.post("/api/v1/drones/deploy", headers=headers)
    assert r1.status_code == 403
    assert "Operator access required" in r1.json()["detail"]

    # Direct drone command
    r2 = client.post("/api/v1/actions/command", headers=headers, json={
        "drone_id": 1,
        "action": "LOITER"
    })
    assert r2.status_code == 403
    assert "Operator access required" in r2.json()["detail"]

    # Create patrol zone
    r3 = client.post("/api/v1/zones/patrol", headers=headers, json={
        "name": "Commander Patrol Attempt",
        "center": [44.33, 23.79],
        "radius_m": 400.0
    })
    assert r3.status_code == 403
    assert "Operator access required" in r3.json()["detail"]

    # Move patrol zone
    r4 = client.post("/api/v1/zones/patrol/move", headers=headers, json={
        "zone_id": 100,
        "center": [44.34, 23.80]
    })
    assert r4.status_code == 403
    assert "Operator access required" in r4.json()["detail"]


def test_https_shenanigans_impersonation_ignored():
    """
    If a logged-in operator passes {"operator_id": "commander_demo"} in the payload
    or tries headers like X-Role, the API ignores the spoofed body field and strictly
    attributes the action to the authenticated user from the database.
    """
    op_token = create_access_token("operator_demo", "OPERATOR")
    headers = {
        "Authorization": f"Bearer {op_token}",
        "X-Role": "COMMANDER",  # Shenanigans header
        "X-User": "commander_demo"  # Shenanigans header
    }

    try:
        res = client.post("/api/v1/drones/deploy", headers=headers, json={
            "operator_id": "commander_demo"  # Shenanigans body
        })
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "DRONE_DEPLOYED"

        # Verify AAR record was attributed to operator_demo, not commander_demo
        with SessionLocal() as db:
            last_event = db.query(AuditLog).order_by(AuditLog.id.desc()).first()
            assert last_event.operator_id == "operator_demo"
            assert last_event.operator_id != "commander_demo"
    finally:
        if 5 in simulator.drones:
            del simulator.drones[5]
        simulator._next_drone_id = 5


def test_role_cannot_be_overwritten():
    """The API provides no endpoint to modify user roles, and roles in DB remain immutable."""
    op_token = create_access_token("operator_demo", "OPERATOR")
    headers = {"Authorization": f"Bearer {op_token}"}

    # Attempting to PUT/PATCH/POST to /auth/users or /auth/me with new role
    r_put = client.put("/api/v1/auth/me", headers=headers, json={"role": "COMMANDER"})
    assert r_put.status_code in (404, 405)

    r_patch = client.patch("/api/v1/auth/users/operator_demo", headers=headers, json={"role": "COMMANDER"})
    assert r_patch.status_code in (404, 405)

    with SessionLocal() as db:
        user = db.query(User).filter(User.username == "operator_demo").first()
        assert user.role == "OPERATOR"
