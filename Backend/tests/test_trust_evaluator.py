import pytest
from app.services.trust_evaluator import DroneTrustEvaluator


def test_nominal_telemetry_evaluates_green():
    evaluator = DroneTrustEvaluator()
    telem = {
        "drone_id": 1,
        "latitude": 44.3350,
        "longitude": 23.8260,
        "altitude": 120.0,
        "ground_speed": 10.0,
        "fix_type": 3,
        "satellites_visible": 14,
        "eph": 0.9,
        "drop_rate_comm": 0.0,
        "rssi": 95.0
    }
    score = evaluator.evaluate(drone_id=1, telemetry=telem)
    assert score.trust_score >= 80.0
    assert score.trust_status == "GREEN"
    assert score.uncertainty_radius_m == 0.0


def test_gps_spoofing_drops_score_to_red():
    evaluator = DroneTrustEvaluator()
    # Step 1: Nominal baseline
    telem1 = {
        "drone_id": 2,
        "latitude": 44.3350,
        "longitude": 23.8260,
        "altitude": 120.0,
        "ground_speed": 10.0,
        "fix_type": 3,
        "satellites_visible": 12,
        "eph": 1.0,
        "drop_rate_comm": 0.0,
        "rssi": 90.0
    }
    evaluator.evaluate(drone_id=2, telemetry=telem1)

    # Step 2: Sudden 500m jump + degraded satellites
    telem2 = {
        "drone_id": 2,
        "latitude": 44.3395,  # ~500m jump in latitude
        "longitude": 23.8310,
        "altitude": 120.0,
        "ground_speed": 10.0,
        "fix_type": 2,
        "satellites_visible": 4,
        "eph": 4.5,
        "drop_rate_comm": 0.0,
        "rssi": 90.0
    }
    score = evaluator.evaluate(drone_id=2, telemetry=telem2)
    assert score.trust_score < 40.0
    assert score.trust_status == "RED"
    assert score.uncertainty_radius_m > 0.0
    assert "Impossible position jump" in score.reason
