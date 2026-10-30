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


def test_aar_verify(client):
    response = client.get("/api/v1/aar/verify")
    assert response.status_code == 200
    report = response.json()
    assert report["is_valid"] is True
