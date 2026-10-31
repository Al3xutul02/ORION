"""
Patrol spacing: keeps the drones on one orbit evenly spread (4 drones 90 deg apart, 3 at 120 deg...).

When a drone leaves the orbit (RTL, corridor, loiter) or joins it again, the ideal slots change.
Instead of teleporting, each drone that is ahead of its slot slows down a little until the gaps
are equal again; drones never fly faster than the normal orbit speed, so the INS plausibility
check never sees an impossible jump. Mirrored in Frontend/src/app/core/patrol.ts.
"""
import math
from typing import Dict

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
