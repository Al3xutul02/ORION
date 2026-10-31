import copy
import math
import random
from typing import List, Dict, Any, Optional, Tuple

from app.services.pathfinder import plan_route
from app.services import weather


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Returns great-circle distance in meters between two WGS84 coordinates."""
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2.0) ** 2
    return 2.0 * R * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def line_segment_intersects_circle(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
    circle_lat: float, circle_lon: float,
    radius_m: float
) -> bool:
    """
    Checks if the straight line segment from (lat1, lon1) to (lat2, lon2)
    passes within `radius_m` meters of (circle_lat, circle_lon).
    """
    steps = 25
    for i in range(steps + 1):
        t = i / steps
        p_lat = lat1 + t * (lat2 - lat1)
        p_lon = lon1 + t * (lon2 - lon1)
        if haversine_distance_m(p_lat, p_lon, circle_lat, circle_lon) <= radius_m:
            return True
    return False


INITIAL_ZONES: List[Dict[str, Any]] = [
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
        "center": [44.3265, 23.8205],
        "radius_m": 480.0,
        "is_active": True,
        "detected_by": "PRECONFIGURED"
    },
    {
        "id": 4,
        "name": "Restricted Threat Zone Bravo",
        "zone_type": "THREAT",
        "geometry_type": "CIRCLE",
        "center": [44.3415, 23.8415],
        "radius_m": 450.0,
        "is_active": True,
        "detected_by": "PRECONFIGURED"
    },
    {
        "id": 100,
        "name": "Patrol Zone Alpha",
        "zone_type": "PATROL",
        "geometry_type": "CIRCLE",
        "center": [44.3350, 23.8300],
        "radius_m": 350.0,
        "is_active": True,
        "detected_by": "PRECONFIGURED"
    }
]

# Candidate safe corridors that can open dynamically across the battlefield
CANDIDATE_CORRIDORS: List[Dict[str, Any]] = [
    {
        "name": "Safe Corridor Alpha",
        "waypoints": [
            [44.3160, 23.8000],
            [44.3220, 23.8050],
            [44.3300, 23.8100],
            [44.3380, 23.8150]
        ]
    },
    {
        "name": "Safe Corridor Bravo (North-West)",
        "waypoints": [
            [44.3160, 23.8000],
            [44.3260, 23.7980],
            [44.3390, 23.8040],
            [44.3450, 23.8220]
        ]
    },
    {
        "name": "Safe Corridor Charlie (South Bypass)",
        "waypoints": [
            [44.3160, 23.8000],
            [44.3145, 23.8160],
            [44.3190, 23.8330],
            [44.3290, 23.8380]
        ]
    },
    {
        "name": "Safe Corridor Delta (High-West)",
        "waypoints": [
            [44.3160, 23.8000],
            [44.3200, 23.8090],
            [44.3290, 23.8140],
            [44.3360, 23.8210]
        ]
    }
]

# Well-separated templates across distinct sectors of the theatre so zones do not stack
DANGER_ZONE_TEMPLATES: List[Dict[str, Any]] = [
    {"name": "Hostile SAM Site Echo", "zone_type": "THREAT", "center": [44.3185, 23.8340], "radius_m": 400.0},
    {"name": "Mobile EW Jammer Foxtrot", "zone_type": "INTERFERENCE", "center": [44.3440, 23.8160], "radius_m": 420.0},
    {"name": "Hostile AA Sector Sierra", "zone_type": "THREAT", "center": [44.3320, 23.8020], "radius_m": 390.0},
    {"name": "Broadband GPS Denial Zone Kilo", "zone_type": "INTERFERENCE", "center": [44.3295, 23.8460], "radius_m": 430.0},
    {"name": "Hostile Radar Dome Tango", "zone_type": "THREAT", "center": [44.3465, 23.8295], "radius_m": 400.0},
]

MAX_ACTIVE_DANGER_ZONES = 4


class TheatreRulesEngine:
    """
    Theatre-of-operations tactical rule engine.
    Maintains tactical zones (Base, Safe Corridors, Interference, Threat).
    Evaluates safe flight paths and blocks hazardous failsafes (e.g., RTL crossing EW zones).
    Supports dynamic battlefield mutations with strict non-overlapping spatial placement.
    """

    def __init__(self):
        self.home_base = {
            "name": "Base Forward Alpha",
            "lat": 44.3160,
            "lon": 23.8000,
            "alt": 150.0
        }
        self._next_id = 10
        self.zones: List[Dict[str, Any]] = copy.deepcopy(INITIAL_ZONES)

    def reset_zones(self):
        self.zones = copy.deepcopy(INITIAL_ZONES)
        self._next_id = 10

    def _alloc_id(self) -> int:
        self._next_id += 1
        return self._next_id

    def active_zones(self) -> List[Dict[str, Any]]:
        return [z for z in self.zones if z.get("is_active", True)]

    def active_corridors(self) -> List[Dict[str, Any]]:
        return [z for z in self.zones if z.get("is_active", True) and z.get("zone_type") == "SAFE_CORRIDOR"]

    def active_danger_zones(self) -> List[Dict[str, Any]]:
        return [z for z in self.zones if z.get("is_active", True) and z.get("zone_type") in ("INTERFERENCE", "THREAT")]

    def active_weather_zones(self) -> List[Dict[str, Any]]:
        return [z for z in self.zones if z.get("is_active", True) and weather.is_weather(z)]

    def blocking_zones(self) -> List[Dict[str, Any]]:
        """Everything a drone must not fly through: EW / threat zones and weather beyond the platform's limits."""
        return self.active_danger_zones() + [z for z in self.active_weather_zones() if weather.is_severe(z)]

    @staticmethod
    def _zone_label(zone: Dict[str, Any]) -> str:
        if weather.is_weather(zone):
            return f"{zone['name']} (WEATHER, {weather.describe(zone)})"
        return f"{zone['name']} ({zone.get('zone_type')})"

    def _active_circles(self, ignore_id: Optional[int] = None) -> List[Dict[str, Any]]:
        return [
            z for z in self.zones
            if z.get("is_active", True)
            and z.get("geometry_type") == "CIRCLE"
            and z.get("id") != ignore_id
        ]

    def _min_clearance_m(
        self,
        lat: float,
        lon: float,
        radius_m: float,
        ignore_id: Optional[int] = None
    ) -> float:
        """
        Returns the smallest edge-to-edge gap (in meters) between a proposed circle
        (lat, lon, radius_m) and all currently active circles on the map.
        Positive means no overlap; negative means overlapping.
        """
        circles = self._active_circles(ignore_id=ignore_id)
        if not circles:
            return 99999.0
        return min(
            haversine_distance_m(lat, lon, c["center"][0], c["center"][1]) - (radius_m + c["radius_m"])
            for c in circles
        )

    def _find_non_overlapping_center(
        self,
        preferred_lat: float,
        preferred_lon: float,
        radius_m: float,
        ignore_id: Optional[int] = None,
        min_gap_m: float = 140.0
    ) -> Tuple[float, float]:
        """
        Finds a coordinate near (preferred_lat, preferred_lon) — or elsewhere in the theatre —
        that maintains at least `min_gap_m` meters of edge-to-edge separation from every active circle.
        """
        if self._min_clearance_m(preferred_lat, preferred_lon, radius_m, ignore_id) >= min_gap_m:
            return preferred_lat, preferred_lon

        best_pos = (preferred_lat, preferred_lon)
        best_clearance = self._min_clearance_m(preferred_lat, preferred_lon, radius_m, ignore_id)

        # Sample expanding rings around the preferred point first, then across the wider theatre
        for attempt in range(60):
            if attempt < 24:
                angle = (attempt / 12.0) * math.pi * 2.0 + random.uniform(-0.2, 0.2)
                dist_deg = 0.0085 + (attempt // 12) * 0.0055
                cand_lat = max(44.3120, min(44.3480, preferred_lat + dist_deg * math.sin(angle)))
                cand_lon = max(23.7940, min(23.8520, preferred_lon + dist_deg * 1.3 * math.cos(angle)))
            else:
                cand_lat = random.uniform(44.3130, 44.3475)
                cand_lon = random.uniform(23.7950, 23.8510)

            clearance = self._min_clearance_m(cand_lat, cand_lon, radius_m, ignore_id)
            if clearance >= min_gap_m:
                return cand_lat, cand_lon
            if clearance > best_clearance:
                best_clearance = clearance
                best_pos = (cand_lat, cand_lon)

        return best_pos

    def _enforce_danger_zone_cap(self, keep_id: Optional[int] = None):
        """Ensures no more than MAX_ACTIVE_DANGER_ZONES are active simultaneously."""
        dangers = [z for z in self.active_danger_zones() if z["id"] != keep_id]
        while len(dangers) >= MAX_ACTIVE_DANGER_ZONES:
            # Prefer retiring dynamically added zones first so the map stays clean
            dynamic = [z for z in dangers if z.get("detected_by") != "PRECONFIGURED"]
            victim = dynamic[0] if dynamic else dangers[0]
            victim["is_active"] = False
            dangers.remove(victim)

    def add_dynamic_interference_zone(
        self,
        name: str,
        center_lat: float,
        center_lon: float,
        radius_m: float = 420.0
    ) -> Dict[str, Any]:
        """
        Dynamically marks or updates a sector as an interference zone when detected by ORION consensus.
        If an ORION_CONSENSUS jammer zone is already active, it relocates/updates that zone to a
        non-overlapping position rather than stacking multiple jammer circles on top of each other.
        """
        radius_m = min(radius_m, 440.0)
        existing_consensus = [
            z for z in self.active_danger_zones()
            if z.get("detected_by") == "ORION_CONSENSUS" and z.get("zone_type") == "INTERFERENCE"
        ]
        if existing_consensus:
            target = existing_consensus[0]
            c_lat, c_lon = self._find_non_overlapping_center(
                center_lat, center_lon, radius_m, ignore_id=target["id"]
            )
            target["center"] = [round(c_lat, 5), round(c_lon, 5)]
            target["radius_m"] = round(radius_m, 1)
            return target

        self._enforce_danger_zone_cap()
        c_lat, c_lon = self._find_non_overlapping_center(center_lat, center_lon, radius_m)
        new_zone = {
            "id": self._alloc_id(),
            "name": name,
            "zone_type": "INTERFERENCE",
            "geometry_type": "CIRCLE",
            "center": [round(c_lat, 5), round(c_lon, 5)],
            "radius_m": round(radius_m, 1),
            "is_active": True,
            "detected_by": "ORION_CONSENSUS"
        }
        self.zones.append(new_zone)
        return new_zone

    def spawn_safe_corridor(self) -> Dict[str, Any]:
        """Opens a new safe corridor (or re-opens a previously closed one)."""
        active_names = {z["name"] for z in self.active_corridors()}
        available = [c for c in CANDIDATE_CORRIDORS if c["name"] not in active_names]

        if available:
            chosen = random.choice(available)
            for z in self.zones:
                if z["name"] == chosen["name"] and not z.get("is_active", True):
                    z["is_active"] = True
                    z["detected_by"] = "THEATRE_INTEL"
                    return z
            new_zone = {
                "id": self._alloc_id(),
                "name": chosen["name"],
                "zone_type": "SAFE_CORRIDOR",
                "geometry_type": "POLYGON",
                "waypoints": copy.deepcopy(chosen["waypoints"]),
                "is_active": True,
                "detected_by": "THEATRE_INTEL"
            }
            self.zones.append(new_zone)
            return new_zone

        idx = self._alloc_id()
        jitter_lat = random.uniform(-0.004, 0.004)
        jitter_lon = random.uniform(-0.005, 0.005)
        new_zone = {
            "id": idx,
            "name": f"Safe Corridor Echo-{idx}",
            "zone_type": "SAFE_CORRIDOR",
            "geometry_type": "POLYGON",
            "waypoints": [
                [44.3160, 23.8000],
                [round(44.3230 + jitter_lat, 4), round(23.8030 + jitter_lon, 4)],
                [round(44.3320 + jitter_lat, 4), round(23.8120 + jitter_lon, 4)],
                [round(44.3390 + jitter_lat, 4), round(23.8230 + jitter_lon, 4)],
            ],
            "is_active": True,
            "detected_by": "THEATRE_INTEL"
        }
        self.zones.append(new_zone)
        return new_zone

    def remove_safe_corridor(self) -> Optional[Dict[str, Any]]:
        """Marks an active safe corridor as compromised and removes it from active use."""
        corridors = self.active_corridors()
        if not corridors:
            return None
        victim = random.choice(corridors)
        victim["is_active"] = False
        return victim

    def spawn_danger_zone(self, force_type: Optional[str] = None) -> Dict[str, Any]:
        """Spawns a new hostile THREAT or INTERFERENCE zone at a non-overlapping position."""
        self._enforce_danger_zone_cap()

        active_names = {z["name"] for z in self.active_danger_zones()}
        candidates = [
            t for t in DANGER_ZONE_TEMPLATES
            if t["name"] not in active_names and (force_type is None or t["zone_type"] == force_type)
        ]
        if candidates:
            tpl = random.choice(candidates)
            r_m = tpl["radius_m"] + random.uniform(-25.0, 25.0)
            c_lat, c_lon = self._find_non_overlapping_center(tpl["center"][0], tpl["center"][1], r_m)
            name = tpl["name"]
            z_type = tpl["zone_type"]
        else:
            idx = self._alloc_id()
            z_type = force_type or random.choice(["THREAT", "INTERFERENCE"])
            label = "Hostile Threat Sector" if z_type == "THREAT" else "Localized EW Jammer"
            name = f"{label} #{idx}"
            r_m = random.uniform(360.0, 430.0)
            pref_lat = random.uniform(44.3160, 44.3460)
            pref_lon = random.uniform(23.8000, 23.8480)
            c_lat, c_lon = self._find_non_overlapping_center(pref_lat, pref_lon, r_m)

        new_zone = {
            "id": self._alloc_id(),
            "name": name,
            "zone_type": z_type,
            "geometry_type": "CIRCLE",
            "center": [round(c_lat, 5), round(c_lon, 5)],
            "radius_m": round(r_m, 1),
            "is_active": True,
            "detected_by": "ORION_CONSENSUS" if z_type == "INTERFERENCE" else "THEATRE_INTEL"
        }
        self.zones.append(new_zone)
        return new_zone

    def remove_danger_zone(self) -> Optional[Dict[str, Any]]:
        """Deactivates/clears an active THREAT or INTERFERENCE zone."""
        dangers = self.active_danger_zones()
        if not dangers:
            return None
        dynamic_dangers = [z for z in dangers if z.get("detected_by") != "PRECONFIGURED"]
        pool = dynamic_dangers if dynamic_dangers else dangers
        cleared = random.choice(pool)
        cleared["is_active"] = False
        return cleared

    # ---- weather ---------------------------------------------------------------------------

    # Weather drifts across this box and is cleared once it leaves.
    WEATHER_BOUNDS = {"lat": (44.300, 44.365), "lon": (23.775, 23.875)}

    def spawn_weather_zone(self, kind: Optional[str] = None) -> Dict[str, Any]:
        """Adds a storm cell, rain band or wind corridor, drifting slowly across the theatre."""
        if len(self.active_weather_zones()) >= 2:
            self.active_weather_zones()[0]["is_active"] = False
        templates = [t for t in weather.WEATHER_TEMPLATES if kind is None or t["weather"] == kind]
        tpl = copy.deepcopy(random.choice(templates))
        # Enter from the west and drift east-north-east at roughly 5 m/s.
        lat = random.uniform(44.318, 44.345)
        lon = random.uniform(23.800, 23.825)
        speed_deg = 5.0 / 111139.0
        heading = random.uniform(-0.35, 0.35)
        zone = {
            "id": self._alloc_id(),
            "name": tpl["name"],
            "zone_type": "WEATHER",
            "geometry_type": "CIRCLE",
            "center": [round(lat, 5), round(lon, 5)],
            "radius_m": tpl["radius_m"],
            "is_active": True,
            "detected_by": "MET_SERVICE",
            "weather": tpl["weather"],
            "wind_ms": tpl["wind_ms"],
            "rain": tpl["rain"],
            "drift": [speed_deg * math.sin(heading), speed_deg * 1.4 * math.cos(heading)],
        }
        self.zones.append(zone)
        return zone

    def clear_weather_zone(self) -> Optional[Dict[str, Any]]:
        zones = self.active_weather_zones()
        if not zones:
            return None
        zones[0]["is_active"] = False
        return zones[0]

    def drift_weather(self, dt: float) -> List[Dict[str, Any]]:
        """Moves every weather zone along its drift; returns the ones that just left the theatre."""
        gone = []
        (lat_min, lat_max), (lon_min, lon_max) = self.WEATHER_BOUNDS["lat"], self.WEATHER_BOUNDS["lon"]
        for z in self.active_weather_zones():
            dlat, dlon = z.get("drift", [0.0, 0.0])
            z["center"] = [z["center"][0] + dlat * dt, z["center"][1] + dlon * dt]
            if not (lat_min <= z["center"][0] <= lat_max and lon_min <= z["center"][1] <= lon_max):
                z["is_active"] = False
                gone.append(z)
        return gone

    def is_path_safe_to_base(self, drone_lat: float, drone_lon: float) -> Tuple[bool, Optional[str]]:
        """
        Tests whether the direct line from (drone_lat, drone_lon) to Home Base
        intersects any active INTERFERENCE or THREAT zones.
        """
        base_lat = self.home_base["lat"]
        base_lon = self.home_base["lon"]

        for zone in self.blocking_zones():
            if zone.get("geometry_type") == "CIRCLE":
                c_lat, c_lon = zone["center"]
                r_m = zone["radius_m"]
                # A storm the drone is already in doesn't block flying home: that's the way out of it.
                if weather.is_weather(zone) and haversine_distance_m(drone_lat, drone_lon, c_lat, c_lon) <= r_m:
                    continue
                if line_segment_intersects_circle(drone_lat, drone_lon, base_lat, base_lon, c_lat, c_lon, r_m):
                    return False, f"Direct path crosses {self._zone_label(zone)}"

        return True, None

    def find_best_corridor(self, drone_lat: float, drone_lon: float) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        """
        Finds an active SAFE_CORRIDOR whose path from (drone_lat, drone_lon) to Base
        does not intersect any active hazard zone (excluding a hazard zone the drone is already inside).
        Returns (corridor_zone, blocking_reason_if_none).
        """
        corridors = self.active_corridors()
        if not corridors:
            return None, "No active safe corridors available in theatre"

        dangers = self.blocking_zones()
        inside_ids = {
            z["id"] for z in dangers
            if z.get("geometry_type") == "CIRCLE"
            and haversine_distance_m(drone_lat, drone_lon, z["center"][0], z["center"][1]) <= z["radius_m"]
        }

        last_block_reason = None
        for corr in corridors:
            wps = list(reversed(corr.get("waypoints", [])))
            if not wps:
                continue
            pts = [[drone_lat, drone_lon]] + wps
            blocked_by = None
            for i in range(len(pts) - 1):
                lat1, lon1 = pts[i]
                lat2, lon2 = pts[i + 1]
                for hz in dangers:
                    if hz["id"] in inside_ids:
                        continue
                    c_lat, c_lon = hz["center"]
                    if line_segment_intersects_circle(lat1, lon1, lat2, lon2, c_lat, c_lon, hz["radius_m"]):
                        blocked_by = hz["name"]
                        break
                if blocked_by:
                    break
            if not blocked_by:
                return corr, None
            last_block_reason = f"Corridor {corr['name']} blocked by {blocked_by}"

        return None, last_block_reason or "All safe corridors blocked by hazard zones"


    def get_zone(self, zone_id: int) -> Optional[Dict[str, Any]]:
        """Returns the active zone with the specified id, or None."""
        for z in self.zones:
            if z.get("id") == zone_id and z.get("is_active", True):
                return z
        return None

    def active_patrol_zones(self) -> List[Dict[str, Any]]:
        """Returns all currently active PATROL zones."""
        return [z for z in self.zones if z.get("is_active", True) and z.get("zone_type") == "PATROL"]

    def add_patrol_zone(
        self,
        name: Optional[str],
        center_lat: float,
        center_lon: float,
        radius_m: float
    ) -> Dict[str, Any]:
        """Creates a new PATROL zone defined by the operator."""
        if not name or not name.strip():
            count = len(self.active_patrol_zones())
            greek = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"]
            label = greek[count] if count < len(greek) else f"Sector-{count + 1}"
            name = f"Patrol Zone {label}"
        zone = {
            "id": self._alloc_id(),
            "name": name.strip(),
            "zone_type": "PATROL",
            "geometry_type": "CIRCLE",
            "center": [round(center_lat, 5), round(center_lon, 5)],
            "radius_m": round(max(50.0, min(1500.0, radius_m)), 1),
            "is_active": True,
            "detected_by": "OPERATOR"
        }
        self.zones.append(zone)
        return zone

    def add_threat_zone(
        self,
        name: Optional[str],
        center_lat: float,
        center_lon: float,
        radius_m: float
    ) -> Dict[str, Any]:
        """Creates a new operator-marked THREAT zone on the map."""
        if not name or not name.strip():
            count = len([z for z in self.zones if z.get("zone_type") == "THREAT" and z.get("is_active", True)])
            greek = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"]
            label = greek[count] if count < len(greek) else f"Sector-{count + 1}"
            name = f"Restricted Threat Zone {label}"
        zone = {
            "id": self._alloc_id(),
            "name": name.strip(),
            "zone_type": "THREAT",
            "geometry_type": "CIRCLE",
            "center": [round(center_lat, 5), round(center_lon, 5)],
            "radius_m": round(max(50.0, min(1500.0, radius_m)), 1),
            "is_active": True,
            "detected_by": "OPERATOR"
        }
        self.zones.append(zone)
        return zone

    def add_safe_corridor(
        self,
        name: Optional[str],
        waypoints: List[List[float]]
    ) -> Dict[str, Any]:
        """Creates a new operator-defined SAFE_CORRIDOR on the map."""
        if not name or not name.strip():
            count = len(self.active_corridors())
            greek = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"]
            label = greek[count] if count < len(greek) else f"Route-{count + 1}"
            name = f"Safe Corridor {label}"
        zone = {
            "id": self._alloc_id(),
            "name": name.strip(),
            "zone_type": "SAFE_CORRIDOR",
            "geometry_type": "POLYGON",
            "waypoints": [[round(pt[0], 5), round(pt[1], 5)] for pt in waypoints],
            "is_active": True,
            "detected_by": "OPERATOR"
        }
        self.zones.append(zone)
        return zone

    def apply_patrol_tactic(self, zone_id: int, tactic: str) -> Dict[str, Any]:
        """
        Applies a tactical swarm maneuver to a patrol zone:
        - SECTOR_ORBIT_SHIFT: Displaces orbit away from active EW jammer boundary to clear airspace.
        - TIGHT_MESH: Contracts orbit radius by 40% for anti-spoofing P2P cross-ranging.
        - WIDE_RECON: Expands orbit radius by 40% for maximum perimeter surveillance sweep.
        - RESYNC_EQUIDISTANT: Rebalances drone phases symmetrically.
        - EGRESS_CORRIDOR: Directs all swarm members in zone to egress along the nearest safe corridor.
        """
        pz = self.get_zone(zone_id)
        if not pz or pz.get("zone_type") != "PATROL":
            return {"status": "ERROR", "message": "Patrol zone not found"}

        tactic_upper = tactic.upper()
        if tactic_upper == "SECTOR_ORBIT_SHIFT":
            jammers = [
                z for z in self.active_danger_zones()
                if z.get("zone_type") == "INTERFERENCE" and z.get("geometry_type") == "CIRCLE"
            ]
            overlapping = []
            for j in jammers:
                d_m = haversine_distance_m(pz["center"][0], pz["center"][1], j["center"][0], j["center"][1])
                if d_m < (pz["radius_m"] + j["radius_m"]):
                    overlapping.append((d_m, j))

            if overlapping:
                overlapping.sort(key=lambda x: x[0])
                d_m, j = overlapping[0]
                v_lat = pz["center"][0] - j["center"][0]
                v_lon = pz["center"][1] - j["center"][1]
                mag = math.hypot(v_lat, v_lon)
                if mag < 1e-6:
                    v_lat, v_lon, mag = 0.002, 0.002, math.hypot(0.002, 0.002)
                needed_shift_m = (pz["radius_m"] + j["radius_m"]) - d_m + 70.0
                needed_shift_m = min(400.0, max(140.0, needed_shift_m))
                shift_lat = (needed_shift_m / 111139.0) * (v_lat / mag)
                shift_lon = (needed_shift_m / (111139.0 * math.cos(math.radians(pz["center"][0])))) * (v_lon / mag)
                new_lat = max(44.3120, min(44.3480, pz["center"][0] + shift_lat))
                new_lon = max(23.7940, min(23.8520, pz["center"][1] + shift_lon))
                pz["center"] = [round(new_lat, 5), round(new_lon, 5)]
                pz["shifted"] = True
                pz["tactic"] = "SECTOR_ORBIT_SHIFT"
                return {
                    "status": "APPLIED",
                    "tactic": "SECTOR_ORBIT_SHIFT",
                    "zone_id": zone_id,
                    "zone_name": pz["name"],
                    "new_center": pz["center"],
                    "message": f"Orbit shifted to ({new_lat:.4f}, {new_lon:.4f}) outside EW jammer boundary."
                }
            else:
                pz["center"] = [round(pz["center"][0] + 0.0015, 5), round(pz["center"][1] + 0.0015, 5)]
                pz["shifted"] = True
                pz["tactic"] = "SECTOR_ORBIT_SHIFT"
                return {
                    "status": "APPLIED",
                    "tactic": "SECTOR_ORBIT_SHIFT",
                    "zone_id": zone_id,
                    "zone_name": pz["name"],
                    "new_center": pz["center"],
                    "message": "Defensive sector orbit offset applied."
                }

        elif tactic_upper == "TIGHT_MESH":
            base_r = pz.get("base_radius_m", pz["radius_m"])
            pz["base_radius_m"] = base_r
            pz["radius_m"] = round(max(100.0, base_r * 0.6), 1)
            pz["tactic"] = "TIGHT_MESH"
            return {
                "status": "APPLIED",
                "tactic": "TIGHT_MESH",
                "zone_id": zone_id,
                "radius_m": pz["radius_m"],
                "message": f"Swarm contracted to tight mesh orbit ({pz['radius_m']}m) for anti-spoofing defense."
            }

        elif tactic_upper == "WIDE_RECON":
            base_r = pz.get("base_radius_m", pz["radius_m"])
            pz["base_radius_m"] = base_r
            pz["radius_m"] = round(min(800.0, base_r * 1.45), 1)
            pz["tactic"] = "WIDE_RECON"
            return {
                "status": "APPLIED",
                "tactic": "WIDE_RECON",
                "zone_id": zone_id,
                "radius_m": pz["radius_m"],
                "message": f"Swarm expanded to wide perimeter recon orbit ({pz['radius_m']}m)."
            }

        elif tactic_upper == "RESYNC_EQUIDISTANT":
            pz["tactic"] = "RESYNC_EQUIDISTANT"
            return {
                "status": "APPLIED",
                "tactic": "RESYNC_EQUIDISTANT",
                "zone_id": zone_id,
                "message": "Swarm phase resynchronization requested."
            }

        elif tactic_upper == "EGRESS_CORRIDOR":
            pz["tactic"] = "EGRESS_CORRIDOR"
            return {
                "status": "APPLIED",
                "tactic": "EGRESS_CORRIDOR",
                "zone_id": zone_id,
                "message": "Swarm emergency egress ordered via safe corridor."
            }

        return {"status": "UNKNOWN_TACTIC", "message": f"Tactic {tactic} not recognized"}

    def delete_zone(self, zone_id: int) -> bool:
        """Deactivates a tactical zone by id (e.g. operator-deleted patrol zone)."""
        for z in self.zones:
            if z.get("id") == zone_id:
                z["is_active"] = False
                return True
        return False

    def plan_target_route(
        self,
        start: Tuple[float, float],
        target: Tuple[float, float],
        path_type: str = "SAFE"
    ) -> Optional[Dict[str, Any]]:
        """
        Plans an optimal A* route to a target location (patrol zone entry or loiter point).
        - SAFE: Zero hazards. Avoids all THREAT, INTERFERENCE, and severe WEATHER zones.
                If start is inside a hazard, exits it immediately.
        - RISKY: Traverses INTERFERENCE and WEATHER zones (treated as soft obstacles),
                 while strictly avoiding all THREAT zones.
        """
        if path_type.upper() == "RISKY":
            # Strictly avoid THREAT zones (hard obstacles).
            # Allow crossing INTERFERENCE and WEATHER zones (soft obstacles, traversable).
            hazards = [
                (z["center"][0], z["center"][1], z["radius_m"], z["name"], False)
                for z in self.active_danger_zones()
                if z.get("geometry_type") == "CIRCLE" and z.get("zone_type") == "THREAT"
            ] + [
                (z["center"][0], z["center"][1], z["radius_m"], z["name"], True)
                for z in self.zones
                if z.get("is_active", True)
                and z.get("geometry_type") == "CIRCLE"
                and z.get("zone_type") in ("INTERFERENCE", "WEATHER")
            ]
        else:
            # SAFE: Avoid all danger zones and severe weather
            hazards = [
                (z["center"][0], z["center"][1], z["radius_m"], z["name"], False)
                for z in self.blocking_zones()
                if z.get("geometry_type") == "CIRCLE"
            ] + [
                (z["center"][0], z["center"][1], z["radius_m"], z["name"], True)
                for z in self.active_weather_zones()
                if not weather.is_severe(z)
            ]
        return plan_route(start, target, hazards)

    def plan_safe_route(self, drone_lat: float, drone_lon: float) -> Optional[Dict[str, Any]]:
        """A* route from the drone to Home Base around every active hazard zone (see pathfinder.py)."""
        # Hard obstacles: EW, threats and weather beyond limits. Lighter weather is only avoided when cheap.
        hazards = [
            (z["center"][0], z["center"][1], z["radius_m"], z["name"])
            for z in self.blocking_zones()
            if z.get("geometry_type") == "CIRCLE"
        ] + [
            (z["center"][0], z["center"][1], z["radius_m"], z["name"], True)
            for z in self.active_weather_zones()
            if not weather.is_severe(z)
        ]
        return plan_route((drone_lat, drone_lon), (self.home_base["lat"], self.home_base["lon"]), hazards)

    def evaluate_tactical_recommendation(
        self,
        drone_id: int,
        drone_lat: float,
        drone_lon: float,
        trust_score: float,
        reason: str,
        flight_mode: str = "PATROL"
    ) -> Optional[Dict[str, Any]]:
        """
        Determines the safe tactical action when a drone encounters EW or degraded trust:
        - If direct RTL passes through an interference/threat zone: Return-To-Home is BLOCKED.
        - If an open Safe Corridor is clear: recommends LOITER_THEN_SAFE_CORRIDOR_RETREAT.
        - If no Safe Corridor is available/clear: recommends LOITER in place until a corridor opens.
        - If a diverted/loitering drone has recovered nominal trust in safe airspace: recommends CONTINUE_PATROL.
        """
        if trust_score >= 70.0:
            if flight_mode in ("LOITER", "CORRIDOR", "RTL", "ROUTE"):
                inside_hazard = False
                for z in self.blocking_zones():
                    if z.get("geometry_type") == "CIRCLE" and z.get("center") and z.get("radius_m"):
                        if haversine_distance_m(drone_lat, drone_lon, z["center"][0], z["center"][1]) <= z["radius_m"]:
                            inside_hazard = True
                            break
                if not inside_hazard:
                    return {
                        "drone_id": drone_id,
                        "trigger_event": "SENSORS_RECALIBRATED_SAFE",
                        "blocked_action": "NONE",
                        "blocked_reason": "Sensors and navigation nominal",
                        "recommended_action": "CONTINUE_PATROL",
                        "reason": (
                            "Sensors recalibrated and verified in clean airspace. "
                            "Action needed: Drone is holding idle in loiter; operator command is required to resume active sector patrol."
                        ),
                        "recommendation_details": (
                            "Sensors recalibrated and clean GPS fix verified. "
                            "Airspace is clear of known hazards; safe to resume regular sector patrol."
                        ),
                        "safe_waypoints": []
                    }
            return None

        is_safe, block_reason = self.is_path_safe_to_base(drone_lat, drone_lon)

        if not is_safe:
            best_corridor, corr_block_reason = self.find_best_corridor(drone_lat, drone_lon)
            if best_corridor:
                c_name = best_corridor["name"]
                wps = list(reversed(best_corridor["waypoints"]))
                return {
                    "drone_id": drone_id,
                    "trigger_event": "TRUST_DEGRADED_EW_HAZARD",
                    "blocked_action": "RETURN_TO_HOME",
                    "blocked_reason": f"Direct Return-to-Home route blocked: {block_reason}",
                    "recommended_action": "LOITER_THEN_SAFE_CORRIDOR_RETREAT",
                    "reason": (
                        f"Hostile electronic warfare hazard active: Direct path to Base is compromised by {block_reason}. "
                        f"Action needed: Direct RTL will cause complete C2 link loss; drone must immediately loiter and divert through Safe Corridor {c_name}."
                    ),
                    "recommendation_details": (
                        f"1. Command immediate LOITER to stabilize. "
                        f"2. Steer egress via {c_name} (avoiding hazard zones) to Base."
                    ),
                    "safe_waypoints": [
                        {"lat": drone_lat, "lon": drone_lon, "alt": 100.0, "action": "LOITER"},
                        *[
                            {"lat": pt[0], "lon": pt[1], "alt": 120.0, "action": "WAYPOINT"}
                            for pt in wps[:-1]
                        ],
                        {"lat": self.home_base["lat"], "lon": self.home_base["lon"], "alt": 150.0, "action": "LAND"}
                    ]
                }
            route = self.plan_safe_route(drone_lat, drone_lon)
            if route:
                legs = len(route["waypoints"]) - 1
                return {
                    "drone_id": drone_id,
                    "trigger_event": "TRUST_DEGRADED_NO_CORRIDOR",
                    "blocked_action": "RETURN_TO_HOME",
                    "blocked_reason": f"Direct RTL blocked ({block_reason}); {corr_block_reason}",
                    "recommended_action": "SAFE_ROUTE_RETREAT",
                    "reason": (
                        f"Hostile interference active: Direct path to Base crosses active hazards ({block_reason}) and corridors are closed. "
                        "Action needed: Direct RTL would fly into hostile threat coverage; drone must follow computed A* obstacle-avoidance route to Base."
                    ),
                    "recommendation_details": (
                        f"1. Fly the computed safe route to Base: {legs} legs, "
                        f"{route['length_m'] / 1000:.1f} km, keeping clear of every active hazard zone. "
                        "2. Re-plan automatically if the zones change."
                    ),
                    "safe_waypoints": [
                        {"lat": lat, "lon": lon, "alt": 120.0, "action": "WAYPOINT"}
                        for lat, lon in route["waypoints"][1:-1]
                    ] + [
                        {"lat": self.home_base["lat"], "lon": self.home_base["lon"], "alt": 150.0, "action": "LAND"}
                    ]
                }
            else:
                return {
                    "drone_id": drone_id,
                    "trigger_event": "TRUST_DEGRADED_NO_CORRIDOR",
                    "blocked_action": "RETURN_TO_HOME",
                    "blocked_reason": f"Direct RTL blocked ({block_reason}); {corr_block_reason}",
                    "recommended_action": "LOITER",
                    "reason": (
                        f"Hostile interference active: Direct RTL is blocked ({block_reason}) and no safe egress corridor is available. "
                        "Action needed: Immediate LOITER is required to hold altitude and prevent wandering into surrounding hostile zones while awaiting corridor clearance."
                    ),
                    "recommendation_details": (
                        "1. Hold position (LOITER) at current altitude to stabilize. "
                        "2. No safe route exists right now: await a Safe Corridor or a change in the zones."
                    ),
                    "safe_waypoints": [
                        {"lat": drone_lat, "lon": drone_lon, "alt": 120.0, "action": "LOITER"}
                    ]
                }
        else:
            if "spoof" in reason.lower() and flight_mode == "PATROL":
                return {
                    "drone_id": drone_id,
                    "trigger_event": "SPOOFING_ATTACK_DETECTED",
                    "blocked_action": "CONTINUE_PATROL",
                    "blocked_reason": "GPS ephemeris corrupted by spoofing attack; patrol trajectory compromised",
                    "recommended_action": "LOITER",
                    "reason": (
                        "Adversary GPS spoofing detected (sudden ephemeris jump). "
                        "Action needed: Continuing patrol with corrupted GPS coordinates will drive the drone off course into danger. "
                        "Immediate LOITER is required to hold position while onboard EKF/IMU filters isolate and reject false satellite signals."
                    ),
                    "recommendation_details": (
                        "1. Command immediate LOITER to hold position and stabilize flight. "
                        "2. Allow onboard EKF/IMU 10 seconds to filter false GPS ephemeris. "
                        "3. Await sensor recalibration before continuing patrol."
                    ),
                    "safe_waypoints": [
                        {"lat": drone_lat, "lon": drone_lon, "alt": 120.0, "action": "LOITER"}
                    ]
                }
            if "weather" in reason.lower() or "wind" in reason.lower():
                return {
                    "drone_id": drone_id,
                    "trigger_event": "WEATHER_LIMIT_EXCEEDED",
                    "blocked_action": "CONTINUE_PATROL",
                    "blocked_reason": "Wind conditions exceed platform structural safety limits",
                    "recommended_action": "RETURN_TO_HOME",
                    "reason": (
                        f"Severe weather warning: {reason}. "
                        "Action needed: Extreme wind gusts exceed maximum airframe limits; immediate egress to Home Base is required to prevent aerodynamic loss of control."
                    ),
                    "recommendation_details": (
                        "1. Abort sector patrol in hazardous weather. "
                        "2. Return to Home Base directly along clear corridor."
                    ),
                    "safe_waypoints": [
                        {"lat": self.home_base["lat"], "lon": self.home_base["lon"], "alt": 150.0, "action": "LAND"}
                    ]
                }
            return {
                "drone_id": drone_id,
                "trigger_event": "TRUST_DEGRADED",
                "blocked_action": "NONE",
                "blocked_reason": "Direct corridor clear",
                "recommended_action": "RETURN_TO_HOME",
                "reason": (
                    "Sensor confidence has dropped below mission safety thresholds. "
                    "Action needed: Return-to-base is required to protect the airframe; direct corridor to Home Base is verified clear of EW hazards."
                ),
                "recommendation_details": "Corridor to Home Base is clear of known EW interference. Standard RTL permitted.",
                "safe_waypoints": [
                    {"lat": self.home_base["lat"], "lon": self.home_base["lon"], "alt": 150.0, "action": "LAND"}
                ]
            }


theatre_rules = TheatreRulesEngine()
