import math

from app.services.pathfinder import MARGIN_M, plan_route
from app.services.theatre_rules import line_segment_intersects_circle

START = (44.340, 23.840)
GOAL = (44.316, 23.800)
# Sits right on the straight line between START and GOAL.
BLOCKER = (44.328, 23.820, 600.0, "EW Jamming Zone")


def legs(route):
    wps = route["waypoints"]
    return list(zip(wps, wps[1:]))


def test_route_goes_around_a_hazard_on_the_direct_line():
    assert line_segment_intersects_circle(*START, *GOAL, BLOCKER[0], BLOCKER[1], BLOCKER[2])
    route = plan_route(START, GOAL, [BLOCKER])
    assert route is not None
    assert route["waypoints"][0] == list(START) and route["waypoints"][-1] == list(GOAL)
    assert len(route["waypoints"]) >= 3  # had to turn at least once
    for (a, b) in legs(route):
        # every leg keeps (almost) the full safety margin from the hazard's edge
        assert not line_segment_intersects_circle(*a, *b, BLOCKER[0], BLOCKER[1], BLOCKER[2] + MARGIN_M * 0.85)
    assert route["avoided"] == ["EW Jamming Zone"]


def test_clear_path_is_a_single_straight_leg():
    far_away = (44.400, 23.950, 300.0, "Far zone")
    route = plan_route(START, GOAL, [far_away])
    assert route is not None and len(route["waypoints"]) == 2


def test_no_route_when_the_drone_is_surrounded():
    m_lat, m_lon = 111139.0, 111139.0 * math.cos(math.radians(START[0]))
    ring = [
        (START[0] + 1000 * math.sin(a) / m_lat, START[1] + 1000 * math.cos(a) / m_lon, 450.0, f"Ring {i}")
        for i, a in enumerate(k * math.pi / 4 for k in range(8))
    ]
    assert plan_route(START, GOAL, ring) is None


def test_rules_recommend_the_computed_route_when_no_corridor_is_open(monkeypatch):
    from app.services.theatre_rules import theatre_rules
    zone = {
        "id": 1, "name": "EW Jamming Zone", "zone_type": "INTERFERENCE", "geometry_type": "CIRCLE",
        "center": [BLOCKER[0], BLOCKER[1]], "radius_m": BLOCKER[2], "is_active": True, "detected_by": "TEST",
    }
    monkeypatch.setattr(theatre_rules, "zones", [zone])
    monkeypatch.setattr(theatre_rules, "home_base", {**theatre_rules.home_base, "lat": GOAL[0], "lon": GOAL[1]})
    rec = theatre_rules.evaluate_tactical_recommendation(2, START[0], START[1], trust_score=30.0, reason="test")
    assert rec["blocked_action"] == "RETURN_TO_HOME"
    assert rec["recommended_action"] == "SAFE_ROUTE_RETREAT"
    assert rec["safe_waypoints"][-1]["action"] == "LAND"


def test_a_drone_inside_a_zone_can_still_get_out():
    around_start = (START[0], START[1], 500.0, "Zone around drone")
    route = plan_route(START, GOAL, [around_start, BLOCKER])
    assert route is not None
    assert route["waypoints"][-1] == list(GOAL)
