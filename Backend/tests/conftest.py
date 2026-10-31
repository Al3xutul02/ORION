import pytest
from fastapi.testclient import TestClient
from app.core.database import Base, engine
from app.main import app


@pytest.fixture(scope="session", autouse=True)
def setup_database():
    Base.metadata.create_all(bind=engine)
    yield
    # Cleanup if needed


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client
