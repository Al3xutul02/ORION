import json
import math
from typing import List, Dict, Any, Optional, Tuple
from app.services.trust_evaluator import haversine_distance_m


def line_segment_intersects_circle(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
    center_lat: float, center_lon: float,
    radius_m: float
) -> bool:
    """
    Checks if the great-circle / straight-line segment from (lat1, lon1) to (lat2, lon2)
    passes within radius_m of a circle center.
    Uses projected Euclidean approximation valid for localized tactical sectors (< 50 km).
    """
    # Convert lat/lon to approximate local metric coordinates relative to center
    meters_per_deg_lat = 111139.0
    meters_per_deg_lon = 111139.0 * math.cos(math.radians(center_lat))

    x1 = (lon1 - center_lon) * meters_per_deg_lon
    y1 = (lat1 - center_lat) * meters_per_deg_lat

    x2 = (lon2 - center_lon) * meters_per_deg_lon
    y2 = (lat2 - center_lat) * meters_per_deg_lat

    dx = x2 - x1
    dy = y2 - y1
    seg_len_sq = dx * dx + dy * dy

    if seg_len_sq == 0:
        return math.sqrt(x1 * x1 + y1 * y1) <= radius_m

    # Projection factor t of center (0,0) onto segment
    t = max(0.0, min(1.0, -(x1 * dx + y1 * dy) / seg_len_sq))
    closest_x = x1 + t * dx
    closest_y = y1 + t * dy

    closest_dist = math.sqrt(closest_x * closest_x + closest_y * closest_y)
    return closest_dist <= radius_m


class TheatreRulesEngine:
    """
    Theatre-of-operations tactical rule engine.
    Maintains tactical zones (Base, Safe Corridors, Interference, Threat).
    Evaluates safe flight paths and blocks hazardous failsafes (e.g., RTL crossing EW zones).
    """

    def __init__(self):
        # Default tactical map centered on a fictitious tactical sector (e.g., 44.316, 23.800)
        self.home_base = {
            "name": "Base Forward Alpha",
            "lat": 44.3160,
            "lon": 23.8000,
            "alt": 150.0
        }
        
        # Predefined tactical zones
        self.zones: List[Dict[str, Any]] = [
            {
                "id": 1,
                "name": "Base Forward Alpha",
                "zone_type": "BASE",
                "geometry_type": "CIRCLE",
                "center": [44.3160, 23.8000],
                "radius_m": 350.0,
                "is_active": True,
                "detected_by": "PRECONFIGURED"
            },
            {
                "id": 2,
                "name": "Safe Corridor Alpha",
                "zone_type": "SAFE_CORRIDOR",
                "geometry_type": "POLYGON",
                "waypoints": [
                    [44.3160, 23.8000],
                    [44.3220, 23.8050],
                    [44.3300, 23.8100],
                    [44.3380, 23.8150]
                ],
                "is_active": True,
                "detected_by": "PRECONFIGURED"
            },
            {
                "id": 3,
                "name": "EW Jamming Zone Sector 4",
                "zone_type": "INTERFERENCE",
                "geometry_type": "CIRCLE",
                "center": [44.3280, 23.8200],  # Positioned directly along direct RTL path of Sector 4
                "radius_m": 600.0,
                "is_active": True,
                "detected_by": "PRECONFIGURED"
            },
            {
                "id": 4,
                "name": "Restricted Threat Zone Bravo",
                "zone_type": "THREAT",
                "geometry_type": "CIRCLE",
                "center": [44.3400, 23.8400],
                "radius_m": 500.0,
                "is_active": True,
                "detected_by": "PRECONFIGURED"
            }
        ]

    def add_dynamic_interference_zone(self, name: str, center_lat: float, center_lon: float, radius_m: float = 700.0) -> Dict[str, Any]:
        """Dynamically marks a sector as an interference zone when detected by ORION consensus."""
        new_zone = {
            "id": len(self.zones) + 1,
            "name": name,
            "zone_type": "INTERFERENCE",
            "geometry_type": "CIRCLE",
            "center": [center_lat, center_lon],
            "radius_m": radius_m,
            "is_active": True,
            "detected_by": "ORION_CONSENSUS"
        }
        self.zones.append(new_zone)
        return new_zone

    def is_path_safe_to_base(self, drone_lat: float, drone_lon: float) -> Tuple[bool, Optional[str]]:
        """
        Tests whether the direct line from (drone_lat, drone_lon) to Home Base
        intersects any active INTERFERENCE or THREAT zones.
        """
        base_lat = self.home_base["lat"]
        base_lon = self.home_base["lon"]

        for zone in self.zones:
            if not zone.get("is_active", True):
                continue

            z_type = zone.get("zone_type")
            if z_type in ("INTERFERENCE", "THREAT"):
                if zone.get("geometry_type") == "CIRCLE":
                    c_lat, c_lon = zone["center"]
                    r_m = zone["radius_m"]
                    if line_segment_intersects_circle(drone_lat, drone_lon, base_lat, base_lon, c_lat, c_lon, r_m):
                        return False, f"Direct path crosses {zone['name']} ({z_type})"
        
        return True, None

    def evaluate_tactical_recommendation(
        self,
        drone_id: int,
        drone_lat: float,
        drone_lon: float,
        trust_score: float,
        reason: str
    ) -> Optional[Dict[str, Any]]:
        """
        Determines the safe tactical action when a drone encounters EW or degraded trust:
        If trust is degraded and direct RTL passes through an interference zone:
        - Return-To-Home is strictly BLOCKED.
        - Loiter in place + retreat through Safe Corridor Alpha is recommended.
        """
        if trust_score >= 70.0:
            return None  # Nominal state, no emergency recommendation needed

        is_safe, block_reason = self.is_path_safe_to_base(drone_lat, drone_lon)

        if not is_safe:
            return {
                "drone_id": drone_id,
                "trigger_event": "TRUST_DEGRADED_EW_HAZARD",
                "blocked_action": "RETURN_TO_HOME",
                "blocked_reason": f"Direct Return-to-Home route blocked: {block_reason}",
                "recommended_action": "LOITER_THEN_SAFE_CORRIDOR_RETREAT",
                "recommendation_details": (
                    "1. Command immediate LOITER to stabilize. "
                    "2. Steer egress via Safe Corridor Alpha (avoiding EW Jamming Zone Sector 4) to Base."
                ),
                "safe_waypoints": [
                    {"lat": drone_lat, "lon": drone_lon, "alt": 100.0, "action": "LOITER"},
                    {"lat": 44.3300, "lon": 23.8100, "alt": 120.0, "action": "WAYPOINT"},
                    {"lat": 44.3160, "lon": 23.8000, "alt": 150.0, "action": "LAND"}
                ]
            }
        else:
            return {
                "drone_id": drone_id,
                "trigger_event": "TRUST_DEGRADED",
                "blocked_action": "NONE",
                "blocked_reason": "Direct corridor clear",
                "recommended_action": "RETURN_TO_HOME",
                "recommendation_details": "Corridor to Home Base is clear of known EW interference. Standard RTL permitted.",
                "safe_waypoints": [
                    {"lat": self.home_base["lat"], "lon": self.home_base["lon"], "alt": 150.0, "action": "RTL"}
                ]
            }


theatre_rules = TheatreRulesEngine()
