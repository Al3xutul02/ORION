"""Spoofing must only falsify the reported GPS fix, never the true airframe position."""
from app.core.database import SessionLocal
from app.services.simulator import OrionFleetSimulator
from app.services.theatre_rules import theatre_rules


def test_spoofing_shifts_reported_position_but_not_true_position():
    sim = OrionFleetSimulator()
    true_before = (sim.drones[2]["lat"], sim.drones[2]["lon"])

    with SessionLocal() as db:
        sim.trigger_gps_spoofing_drone2(db, target_drone_id=2)

    d = sim.drones[2]
    assert (d["lat"], d["lon"]) == true_before
    rep_lat, rep_lon = sim._reported_position(d)
    off_lat, off_lon = d["spoof_offset"]
    assert abs(rep_lat - (true_before[0] + off_lat)) < 1e-12
    assert abs(rep_lon - (true_before[1] + off_lon)) < 1e-12


def test_spoofed_fix_inside_threat_zone_does_not_block_recalibration():
    """A drone whose *fake* fix lies inside a threat zone, but which is really in clean
    airspace, must still recalibrate: hazards act on the true position."""
    theatre_rules.reset_zones()
    sim = OrionFleetSimulator()
    d = sim.drones[2]
    d["mode"] = "LOITER"
    d["loiter_until"] = float("inf")

    # Put the fake fix right on top of an active danger zone centre.
    zone = next(z for z in theatre_rules.active_danger_zones() if z.get("geometry_type") == "CIRCLE")
    d["spoofed"] = True
    d["spoof_offset"] = (zone["center"][0] - d["lat"], zone["center"][1] - d["lon"])

    with SessionLocal() as db:
        for _ in range(10):  # 5 s at 2 Hz, above the 3.5 s LOITER threshold
            sim._update_drone_recalibration(db, 2, d, 0.5)

    assert d["spoofed"] is False
    assert d["spoof_offset"] == (0.0, 0.0)
