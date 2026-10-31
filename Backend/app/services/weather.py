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
