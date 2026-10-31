import pytest
from app.services.theatre_rules import TheatreRulesEngine, haversine_distance_m, MAX_ACTIVE_DANGER_ZONES


def test_rtl_blocking_when_crossing_ew_zone():
    engine = TheatreRulesEngine()

    # Drone positioned at (44.3350, 23.8350)
    # Direct line to Base (44.3160, 23.8000) crosses EW Jamming Zone Sector 4
    drone_lat = 44.3350
    drone_lon = 23.8350

    is_safe, reason = engine.is_path_safe_to_base(drone_lat, drone_lon)
    assert is_safe is False
    assert "EW Jamming Zone Sector 4" in reason

    rec = engine.evaluate_tactical_recommendation(
        drone_id=2,
        drone_lat=drone_lat,
        drone_lon=drone_lon,
        trust_score=30.0,
        reason="Spoofed GPS"
    )
    assert rec is not None
    assert rec["blocked_action"] == "RETURN_TO_HOME"
    assert "LOITER" in rec["recommended_action"]
    assert rec.get("reason") is not None and len(rec["reason"]) > 10


def test_safe_path_allows_standard_recommendation():
    engine = TheatreRulesEngine()
    # Drone positioned west of EW zone with direct safe line to Base
    drone_lat = 44.3200
    drone_lon = 23.7950

    is_safe, reason = engine.is_path_safe_to_base(drone_lat, drone_lon)
    assert is_safe is True
    assert reason is None


def test_recalibrated_drone_gets_continue_patrol_recommendation():
    engine = TheatreRulesEngine()
    # Drone is in safe airspace holding in LOITER with nominal trust
    rec = engine.evaluate_tactical_recommendation(
        drone_id=2,
        drone_lat=44.3200,
        drone_lon=23.7950,
        trust_score=95.0,
        reason="Sensors nominal",
        flight_mode="LOITER"
    )
    assert rec is not None
    assert rec["recommended_action"] == "CONTINUE_PATROL"
    assert rec["trigger_event"] == "SENSORS_RECALIBRATED_SAFE"
    assert rec.get("reason") is not None and "recalibrated" in rec["reason"].lower()


def test_spoofed_drone_in_patrol_recommends_loiter_with_reason():
    engine = TheatreRulesEngine()
    # Drone in PATROL mode suffers sudden GPS spoofing jump in clean airspace
    rec = engine.evaluate_tactical_recommendation(
        drone_id=2,
        drone_lat=44.3200,
        drone_lon=23.7950,
        trust_score=28.0,
        reason="GPS spoofing detected on Drone 2",
        flight_mode="PATROL"
    )
    assert rec is not None
    assert rec["recommended_action"] == "LOITER"
    assert rec["blocked_action"] == "CONTINUE_PATROL"
    assert "reason" in rec and len(rec["reason"]) > 15


def test_spawned_danger_zones_do_not_overlap_or_exceed_cap():
    engine = TheatreRulesEngine()
    for _ in range(10):
        engine.spawn_danger_zone()
        engine.add_dynamic_interference_zone("Mobile EW Jammer Sector", 44.3350, 23.8300, 400.0)

        active_dangers = engine.active_danger_zones()
        assert len(active_dangers) <= MAX_ACTIVE_DANGER_ZONES

        circles = [z for z in engine.active_zones() if z.get("geometry_type") == "CIRCLE"]
        for i in range(len(circles)):
            for j in range(i + 1, len(circles)):
                c1, c2 = circles[i], circles[j]
                dist = haversine_distance_m(c1["center"][0], c1["center"][1], c2["center"][0], c2["center"][1])
                assert dist >= (c1["radius_m"] + c2["radius_m"]), (
                    f"Zones {c1['name']} and {c2['name']} overlap! dist={dist:.1f}m < {c1['radius_m'] + c2['radius_m']:.1f}m"
                )
