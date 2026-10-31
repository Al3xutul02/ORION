"""
Weather hazards for the simulated theatre: storm cells, heavy rain and strong wind.

A weather zone is a CIRCLE zone with zone_type "WEATHER" and a few extra fields:
  weather: "STORM" | "RAIN" | "WIND"
  wind_ms: sustained wind inside the zone
  rain:    "NONE" | "MODERATE" | "HEAVY"
  drift:   [dlat, dlon] per second (weather moves across the theatre)

Above the platform's wind limit a zone is a hard obstacle, like an EW or threat zone: RTL
through it is blocked and routes go around it. Below the limit it is only something to avoid
when convenient, and it degrades the drone (datalink rain fade, faster battery drain) in ways
ORION attributes to weather rather than to an attack.

Mirrored in Frontend/src/app/core/platform.ts; keep the two in step.
"""
from typing import Any, Dict, List, Optional

# Simulated multirotor patrol profile (see the drone details panel).
MAX_WIND_MS = 12.0

WEATHER_TEMPLATES: List[Dict[str, Any]] = [
    {"name": "Storm cell", "weather": "STORM", "wind_ms": 18.0, "rain": "HEAVY", "radius_m": 650.0},
    {"name": "Heavy rain band", "weather": "RAIN", "wind_ms": 7.0, "rain": "HEAVY", "radius_m": 750.0},
    {"name": "Strong wind corridor", "weather": "WIND", "wind_ms": 15.0, "rain": "NONE", "radius_m": 800.0},
]


def is_weather(zone: Dict[str, Any]) -> bool:
    return zone.get("zone_type") == "WEATHER"


def is_severe(zone: Dict[str, Any]) -> bool:
    """Beyond what the platform can fly in: treat it like a hazard zone."""
    return is_weather(zone) and float(zone.get("wind_ms", 0.0)) > MAX_WIND_MS


def describe(zone: Dict[str, Any]) -> str:
    parts = [f"wind {zone.get('wind_ms', 0):.0f} m/s"]
    rain = zone.get("rain", "NONE")
    if rain != "NONE":
        parts.append(f"{rain.lower()} rain")
    if is_severe(zone):
        parts.append(f"above the {MAX_WIND_MS:.0f} m/s limit")
    return ", ".join(parts)


def effects(zone: Optional[Dict[str, Any]]) -> Dict[str, float]:
    """How the weather at the drone's position changes its telemetry."""
    if not zone:
        return {"drop_add": 0.0, "rssi_loss": 0.0, "eph_add": 0.0, "battery_mult": 1.0}
    rain = zone.get("rain", "NONE")
    wind = float(zone.get("wind_ms", 0.0))
    return {
        # Rain fade on the datalink
        "drop_add": {"NONE": 0.0, "MODERATE": 6.0, "HEAVY": 14.0}.get(rain, 0.0),
        "rssi_loss": {"NONE": 0.0, "MODERATE": 12.0, "HEAVY": 28.0}.get(rain, 0.0),
        # Gusts make position hold noisier
        "eph_add": round(min(1.5, wind / 12.0), 2),
        # Fighting the wind drains the battery faster
        "battery_mult": round(1.0 + min(1.0, wind / 15.0), 2),
    }


def weather_at(zones: List[Dict[str, Any]], lat: float, lon: float, distance_m) -> Optional[Dict[str, Any]]:
    """The strongest weather zone covering (lat, lon), if any."""
    here = [
        z for z in zones
        if is_weather(z) and z.get("is_active", True)
        and distance_m(lat, lon, z["center"][0], z["center"][1]) <= z["radius_m"]
    ]
    return max(here, key=lambda z: float(z.get("wind_ms", 0.0)), default=None)

def weather_polygon(lat: float, lon: float, radius_m: float, kind: str = "STORM", seed: int = 1, steps: int = 72) -> List[List[float]]:
    """Generates an organic, realistic polygon contour for weather events (squall lines, convective anvil lobes, wind streams)."""
    import math
    m_per_deg_lat = 111139.0
    m_per_deg_lon = m_per_deg_lat * math.cos(math.radians(lat))
    base_dlat = radius_m / m_per_deg_lat
    base_dlon = radius_m / m_per_deg_lon
    phase = ((seed * 137.5) % 360) * (math.pi / 180)
    ring: List[List[float]] = []
    for i in range(steps + 1):
        a = (i / steps) * math.pi * 2
        if kind == "RAIN":
            front_angle = a - 0.52
            stretch_lon = 1.7
            stretch_lat = 0.72
            wave = 0.16 * math.sin(3 * a + phase) + 0.08 * math.cos(5 * a)
            r = 1.0 + wave
            cos_a = math.cos(front_angle) * stretch_lon
            sin_a = math.sin(front_angle) * stretch_lat
            ring.append([round(lon + base_dlon * cos_a * r, 6), round(lat + base_dlat * sin_a * r, 6)])
        elif kind == "WIND":
            corridor_angle = a + phase * 0.2
            stretch_lon = 1.9
            stretch_lat = 0.65
            taper = 1.0 + 0.22 * math.cos(corridor_angle) + 0.1 * math.sin(2 * corridor_angle)
            cos_a = math.cos(corridor_angle) * stretch_lon
            sin_a = math.sin(corridor_angle) * stretch_lat
            ring.append([round(lon + base_dlon * cos_a * taper, 6), round(lat + base_dlat * sin_a * taper, 6)])
        else:
            lobe1 = 0.24 * math.sin(3 * a + phase)
            lobe2 = 0.14 * math.cos(5 * a + phase * 1.3)
            lobe3 = 0.07 * math.sin(7 * a)
            r = 1.0 + lobe1 + lobe2 + lobe3
            ring.append([round(lon + base_dlon * math.cos(a) * r, 6), round(lat + base_dlat * math.sin(a) * r, 6)])
    return ring
