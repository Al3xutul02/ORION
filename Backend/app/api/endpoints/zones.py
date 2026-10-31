from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.services.aar_service import aar_service
from app.schemas.zone import CreatePatrolZoneRequest, CreateThreatZoneRequest, CreateSafeCorridorRequest, ExecuteZoneTacticRequest
from app.services.theatre_rules import theatre_rules
from app.schemas.zone import TacticalZoneResponse

router = APIRouter(prefix="/zones", tags=["Tactical Theatre Zones"])


@router.get("", response_model=List[Dict[str, Any]])
def get_zones():
    """Returns active tactical zones (Base, Safe Corridors, Interference, Threat)."""
    return theatre_rules.zones


@router.get("/geojson")
def get_zones_geojson():
    """Returns tactical zones formatted as GeoJSON for frontend MapLibre GL rendering."""
    features = []
    for z in theatre_rules.zones:
        g_type = z.get("geometry_type")
        z_type = z.get("zone_type")
        name = z.get("name")

        if g_type == "CIRCLE":
            lat, lon = z["center"]
            if z_type == "WEATHER":
                from app.services.weather import weather_polygon
                poly_coords = weather_polygon(lat, lon, z["radius_m"], z.get("weather", "STORM"), z.get("id", 1))
                features.append({
                    "type": "Feature",
                    "properties": {
                        "id": z["id"],
                        "name": name,
                        "zone_type": z_type,
                        "radius_m": z["radius_m"],
                        "weather": z.get("weather"),
                        "wind_ms": z.get("wind_ms"),
                        "rain": z.get("rain"),
                        "is_active": z.get("is_active", True),
                        "detected_by": z.get("detected_by", "PRECONFIGURED")
                    },
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [poly_coords]
                    }
                })
            else:
                features.append({
                    "type": "Feature",
                    "properties": {
                        "id": z["id"],
                        "name": name,
                        "zone_type": z_type,
                        "radius_m": z["radius_m"],
                        "is_active": z.get("is_active", True),
                        "detected_by": z.get("detected_by", "PRECONFIGURED")
                    },
                    "geometry": {
                        "type": "Point",
                        "coordinates": [lon, lat]  # GeoJSON is [lon, lat]
                    }
                })
        elif g_type == "POLYGON":
            coords = [[pt[1], pt[0]] for pt in z.get("waypoints", [])]
            features.append({
                "type": "Feature",
                "properties": {
                    "id": z["id"],
                    "name": name,
                    "zone_type": z_type,
                    "is_active": z.get("is_active", True),
                    "detected_by": z.get("detected_by", "PRECONFIGURED")
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords
                }
            })

    return {
        "type": "FeatureCollection",
        "features": features
    }


@router.post("/patrol")
def create_patrol_zone(payload: CreatePatrolZoneRequest, db: Session = Depends(get_db)):
    """Creates a new user-defined patrol zone on the map."""
    zone = theatre_rules.add_patrol_zone(
        name=payload.name,
        center_lat=payload.center[0],
        center_lon=payload.center[1],
        radius_m=payload.radius_m
    )
    aar_service.log_event(
        db=db,
        event_type="PATROL_ZONE_CREATED",
        drone_id=None,
        details={
            "zone_id": zone["id"],
            "name": zone["name"],
            "center": zone["center"],
            "radius_m": zone["radius_m"]
        },
        operator_id="OPERATOR_1"
    )
    return zone


@router.delete("/{zone_id}")
def delete_zone(zone_id: int, db: Session = Depends(get_db)):
    """Deletes / clears a tactical zone by id (e.g. operator-deleted patrol zone)."""
    zone = theatre_rules.get_zone(zone_id)
    if not zone:
        # Fallback check if it's in zones list
        for z in theatre_rules.zones:
            if z.get("id") == zone_id:
                zone = z
                break
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")

    theatre_rules.delete_zone(zone_id)
    aar_service.log_event(
        db=db,
        event_type="ZONE_DELETED",
        drone_id=None,
        details={
            "zone_id": zone_id,
            "name": zone.get("name"),
            "zone_type": zone.get("zone_type")
        },
        operator_id="OPERATOR_1"
    )
    return {"status": "DELETED", "id": zone_id}


@router.post("/threat")
def create_threat_zone(payload: CreateThreatZoneRequest, db: Session = Depends(get_db)):
    """Creates a new operator-marked threat zone on the map."""
    zone = theatre_rules.add_threat_zone(
        name=payload.name,
        center_lat=payload.center[0],
        center_lon=payload.center[1],
        radius_m=payload.radius_m
    )
    aar_service.log_event(
        db=db,
        event_type="THREAT_ZONE_DECLARED",
        drone_id=None,
        details={
            "zone_id": zone["id"],
            "name": zone["name"],
            "center": zone["center"],
            "radius_m": zone["radius_m"]
        },
        operator_id="OPERATOR_1"
    )
    return zone


@router.post("/corridor")
def create_safe_corridor(payload: CreateSafeCorridorRequest, db: Session = Depends(get_db)):
    """Creates a new operator-defined safe corridor on the map."""
    zone = theatre_rules.add_safe_corridor(
        name=payload.name,
        waypoints=payload.waypoints
    )
    aar_service.log_event(
        db=db,
        event_type="SAFE_CORRIDOR_DECLARED",
        drone_id=None,
        details={
            "corridor_id": zone["id"],
            "name": zone["name"],
            "waypoints": zone["waypoints"]
        },
        operator_id="OPERATOR_1"
    )
    return zone


@router.post("/tactic")
def execute_zone_tactic(payload: ExecuteZoneTacticRequest, db: Session = Depends(get_db)):
    """Executes a swarm tactical maneuver for an active patrol zone."""
    from app.services.simulator import simulator
    res = simulator.apply_zone_tactic(db, payload.zone_id, payload.tactic, operator_id="OPERATOR_1")
    if res.get("status") == "ERROR":
        raise HTTPException(status_code=404, detail=res.get("message"))
    aar_service.log_event(
        db=db,
        event_type="PATROL_TACTIC_EXECUTED",
        drone_id=None,
        details={
            "zone_id": payload.zone_id,
            "tactic": payload.tactic,
            "result": res
        },
        operator_id="OPERATOR_1"
    )
    return res
