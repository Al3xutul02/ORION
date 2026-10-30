import pytest
from app.services.theatre_rules import TheatreRulesEngine


def test_rtl_blocking_when_crossing_ew_zone():
    engine = TheatreRulesEngine()
    
    # Drone positioned at (44.3350, 23.8350)
    # Direct line to Base (44.3160, 23.8000) crosses EW Jamming Zone Sector 4 (center 44.3280, 23.8200)
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


def test_safe_path_allows_standard_recommendation():
    engine = TheatreRulesEngine()
    # Drone positioned west of EW zone with direct safe line to Base
    drone_lat = 44.3200
    drone_lon = 23.7950

    is_safe, reason = engine.is_path_safe_to_base(drone_lat, drone_lon)
    assert is_safe is True
    assert reason is None
