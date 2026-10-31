"""
Patrol spacing: keeps the drones on one orbit evenly spread (4 drones 90 deg apart, 3 at 120 deg...).

When a drone leaves the orbit (RTL, corridor, loiter) or joins it again, the ideal slots change.
Instead of teleporting, each drone that is ahead of its slot slows down a little until the gaps
are equal again; drones never fly faster than the normal orbit speed, so the INS plausibility
check never sees an impossible jump. Mirrored in Frontend/src/app/core/patrol.ts.
"""
import math
from typing import Callable, Dict, Optional, Tuple

TAU = 2 * math.pi
MIN_RATE_FACTOR = 0.4  # a drone waits for its slot at no less than 40% of orbit speed
GAIN = 4.0             # how hard a drone brakes per radian ahead of its slot


def wrap(a: float) -> float:
    """Angle difference folded into (-pi, pi]."""
    return (a + math.pi) % TAU - math.pi


def slot_errors(angles: Dict[int, float]) -> Dict[int, float]:
    """
    How far (radians) each drone is from its evenly spaced slot; positive = drone is ahead.
    Drones keep their order around the orbit; the slot pattern is rotated to fit them best.
    """
    n = len(angles)
    if n < 2:
        return {i: 0.0 for i in angles}
    order = sorted(angles, key=lambda i: angles[i] % TAU)
    step = TAU / n
    phase = math.atan2(
        sum(math.sin(angles[i] - k * step) for k, i in enumerate(order)),
        sum(math.cos(angles[i] - k * step) for k, i in enumerate(order)),
    )
    return {i: wrap(angles[i] - (phase + k * step)) for k, i in enumerate(order)}


def spacing_rates(angles: Dict[int, float], base_rate: float) -> Dict[int, float]:
    """Angular speed for each drone on the orbit: base speed, or slower while ahead of its slot."""
    return {
        i: base_rate * max(MIN_RATE_FACTOR, 1.0 - GAIN * max(0.0, err))
        for i, err in slot_errors(angles).items()
    }


def max_spacing_error_deg(angles: Dict[int, float]) -> float:
    errs = slot_errors(angles).values()
    return math.degrees(max((abs(e) for e in errs), default=0.0))


# ---- Holding off the orbit ------------------------------------------------------------------
# A drone told to LOITER on the orbit would sit in the path of the drones still patrolling it.
# It steps out of the way first: about 160 m outside the orbit (or inside, if outside isn't
# clear), and if neither is clear it holds where it is but climbs for vertical separation.

NEAR_ORBIT = 0.3       # within 30% of the orbit radius counts as "on the orbit"
HOLD_CLEARANCE = 0.5   # step out to 150% (or in to 50%) of the orbit radius, ~160 m
HOLD_CLIMB_M = 30.0    # vertical separation when there is nowhere clear to step out to


def hold_point(lat: float, lon: float, center: Tuple[float, float], radii: Tuple[float, float],
               is_clear: Callable[[float, float], bool]) -> Optional[Tuple[float, float]]:
    """Where a drone at (lat, lon) should hold so it is off the orbit; None = already clear of it
    or nowhere safe to go (the caller then separates vertically if it is on the orbit)."""
    (c_lat, c_lon), (r_lat, r_lon) = center, radii
    r = math.hypot((lat - c_lat) / r_lat, (lon - c_lon) / r_lon)
    if abs(r - 1.0) >= NEAR_ORBIT or r < 1e-9:
        return None
    for target in (1.0 + HOLD_CLEARANCE, 1.0 - HOLD_CLEARANCE):
        p = (c_lat + (lat - c_lat) / r * target, c_lon + (lon - c_lon) / r * target)
        if is_clear(*p):
            return p
    return None


def on_orbit(lat: float, lon: float, center: Tuple[float, float], radii: Tuple[float, float]) -> bool:
    (c_lat, c_lon), (r_lat, r_lon) = center, radii
    return abs(math.hypot((lat - c_lat) / r_lat, (lon - c_lon) / r_lon) - 1.0) < NEAR_ORBIT
