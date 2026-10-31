import math

from app.core.database import SessionLocal
from app.models.audit import AuditLog
from app.services import patrol
from app.services.simulator import PATROL_ANGULAR_SPEED, OrionFleetSimulator

BASE = 0.08


def fly(angles, seconds, dt=0.5):
    """Moves drones around the orbit with the coordinator's rates; returns the slowest factor used."""
    slowest = 1.0
    for _ in range(int(seconds / dt)):
        rates = patrol.spacing_rates(angles, BASE)
        slowest = min(slowest, min(rates.values()) / BASE)
        assert max(rates.values()) <= BASE  # never faster than the normal orbit (INS-safe)
        for i in angles:
            angles[i] += rates[i] * dt
    return slowest


def gaps_deg(angles):
    a = sorted(x % patrol.TAU for x in angles.values())
    return [math.degrees((b - c) % patrol.TAU) for c, b in zip(a, a[1:] + a[:1])]


def test_an_evenly_spread_patrol_is_left_alone():
    angles = {1: 0.0, 2: math.pi / 2, 3: math.pi, 4: 3 * math.pi / 2}
    assert patrol.max_spacing_error_deg(angles) < 1e-9
    assert set(patrol.spacing_rates(angles, BASE).values()) == {BASE}


def test_three_drones_spread_to_120_degrees_after_one_leaves():
    angles = {1: 0.0, 2: math.pi / 2, 3: math.pi}  # drone 4 left the 90-degree pattern
    assert patrol.max_spacing_error_deg(angles) > 25
    slowest = fly(angles, 45)
    assert slowest >= patrol.MIN_RATE_FACTOR
    assert all(abs(g - 120) < 3 for g in gaps_deg(angles))


def test_a_drone_rejoining_next_to_another_gets_room_made_for_it():
    angles = {1: 0.0, 2: 0.15, 3: 2 * math.pi / 3, 4: 4 * math.pi / 3}
    order_before = sorted(angles, key=lambda i: angles[i] % patrol.TAU)
    fly(angles, 60)
    assert all(abs(g - 90) < 3 for g in gaps_deg(angles))
    # nobody overtakes anybody: drones keep their order around the orbit
    start = min(angles, key=lambda i: angles[i] % patrol.TAU)
    order_after = sorted(angles, key=lambda i: (angles[i] - angles[start]) % patrol.TAU)
    k = order_before.index(start)
    assert order_after == order_before[k:] + order_before[:k]


def test_simulator_respaces_the_orbit_and_logs_who_left():
    sim = OrionFleetSimulator()
    with SessionLocal() as db:
        sim._coordinate_patrol(db)  # the starting four: nothing to log
        before = db.query(AuditLog).filter(AuditLog.event_type == "PATROL_REBALANCED").count()
        sim.execute_drone_action(4, "LOITER")
        for _ in range(120):  # 60 s at 2 Hz
            sim._coordinate_patrol(db)
            for d_id, d in sim.drones.items():
                sim._move_drone(db, d_id, d, 0.5)
        logs = (
            db.query(AuditLog).filter(AuditLog.event_type == "PATROL_REBALANCED")
            .order_by(AuditLog.id).all()[before:]
        )
    assert len(logs) == 1 and logs[0].drone_id == 4 and "120 deg" in logs[0].details
    on_orbit = {i: sim.drones[i]["offset_angle"] for i in (1, 2, 3)}
    assert all(abs(g - 120) < 3 for g in gaps_deg(on_orbit))
    assert all(sim.drones[i]["patrol_rate"] <= PATROL_ANGULAR_SPEED for i in (1, 2, 3))


CENTER, RADII = (44.335, 23.83), (0.003, 0.004)


def orbit_r(lat, lon):
    return math.hypot((lat - CENTER[0]) / RADII[0], (lon - CENTER[1]) / RADII[1])


def test_hold_point_steps_off_the_orbit_outward_then_inward_then_nowhere():
    on = (CENTER[0], CENTER[1] + RADII[1])  # east point of the orbit
    out = patrol.hold_point(*on, CENTER, RADII, lambda la, lo: True)
    assert abs(orbit_r(*out) - 1.5) < 1e-9
    inward = patrol.hold_point(*on, CENTER, RADII, lambda la, lo: orbit_r(la, lo) < 1)
    assert abs(orbit_r(*inward) - 0.5) < 1e-9
    assert patrol.hold_point(*on, CENTER, RADII, lambda la, lo: False) is None
    assert patrol.hold_point(CENTER[0], CENTER[1] + 0.2 * RADII[1], CENTER, RADII, lambda la, lo: True) is None


def run_ticks(sim, seconds, dt=0.5, each=None):
    with SessionLocal() as db:
        for _ in range(int(seconds / dt)):
            sim._coordinate_patrol(db)
            for d_id, d in sim.drones.items():
                sim._move_drone(db, d_id, d, dt)
            if each:
                each()


def test_loitering_drone_steps_out_of_the_patrol_path(monkeypatch):
    from app.services.simulator import theatre_rules
    from app.services.trust_evaluator import haversine_distance_m
    monkeypatch.setattr(theatre_rules, "blocking_zones", lambda: [])
    sim = OrionFleetSimulator()
    sim.execute_drone_action(4, "LOITER")
    run_ticks(sim, 15)
    d4 = sim.drones[4]
    assert abs(orbit_r(d4["lat"], d4["lon"]) - 1.5) < 0.01 and not d4["repositioning"]
    assert sim.get_telemetry(4)["ground_speed"] == 0.0 and d4["alt"] == 120.0

    closest = []
    run_ticks(sim, 90, each=lambda: closest.append(min(
        haversine_distance_m(d4["lat"], d4["lon"], sim.drones[i]["lat"], sim.drones[i]["lon"]) for i in (1, 2, 3)
    )))
    assert min(closest) > 120  # the patrol never passes through the holding drone


def test_loitering_drone_climbs_when_there_is_nowhere_clear_to_step_out(monkeypatch):
    from app.services.simulator import theatre_rules
    d4_start = (44.332, 23.83)  # south point of the orbit
    monkeypatch.setattr(theatre_rules, "blocking_zones", lambda: [
        {"geometry_type": "CIRCLE", "center": [44.3315, 23.83], "radius_m": 40.0},  # just outside D4
        {"geometry_type": "CIRCLE", "center": [44.3335, 23.83], "radius_m": 40.0},  # just inside
    ])
    sim = OrionFleetSimulator()
    sim.execute_drone_action(4, "LOITER")
    run_ticks(sim, 5)
    d4 = sim.drones[4]
    assert (round(d4["lat"], 6), round(d4["lon"], 6)) == d4_start and d4["alt"] == 150.0
    sim.execute_drone_action(4, "CONTINUE_PATROL")
    run_ticks(sim, 1)
    assert d4["alt"] == 120.0
