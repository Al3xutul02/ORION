import pytest
from fastapi.testclient import TestClient
from app.core.database import Base, engine, SessionLocal, seed_default_users
from app.core.security import create_access_token
from app.main import app


@pytest.fixture(scope="session", autouse=True)
def setup_database():
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        seed_default_users(db)
    yield


@pytest.fixture
def operator_token():
    return create_access_token("operator_demo", "OPERATOR")


@pytest.fixture
def commander_token():
    return create_access_token("commander_demo", "COMMANDER")


@pytest.fixture
def operator_headers(operator_token):
    return {"Authorization": f"Bearer {operator_token}"}


@pytest.fixture
def commander_headers(commander_token):
    return {"Authorization": f"Bearer {commander_token}"}


@pytest.fixture
def client(operator_token):
    with TestClient(app) as test_client:
        test_client.headers["Authorization"] = f"Bearer {operator_token}"
        yield test_client
