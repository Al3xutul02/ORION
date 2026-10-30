from typing import List, Dict, Any
from fastapi import APIRouter
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
