from app.core.database import SessionLocal
from app.models.audit import AuditLog
from app.models.recommendation import ActionRecommendation
from app.services import weather
from app.services.pathfinder import plan_route
from app.services.simulator import simulator
from app.services.theatre_rules import line_segment_intersects_circle, theatre_rules

START = (44.340, 23.840)
GOAL = (44.316, 23.800)
ON_THE_LINE = [44.328, 23.820]


def wx_zone(kind: str, center=ON_THE_LINE, radius=600.0, zid=900):
    tpl = next(t for t in weather.WEATHER_TEMPLATES if t["weather"] == kind)
    return {
        "id": zid, "name": tpl["name"], "zone_type": "WEATHER", "geometry_type": "CIRCLE",
        "center": list(center), "radius_m": radius, "is_active": True, "detected_by": "TEST",
        "weather": kind, "wind_ms": tpl["wind_ms"], "rain": tpl["rain"], "drift": [0.0, 0.0],
    }


def use_zones(monkeypatch, zones):
    monkeypatch.setattr(theatre_rules, "zones", zones)
    monkeypatch.setattr(theatre_rules, "home_base", {**theatre_rules.home_base, "lat": GOAL[0], "lon": GOAL[1]})


def test_storm_beyond_wind_limit_blocks_rtl_and_is_routed_around(monkeypatch):
    storm = wx_zone("STORM")
    assert weather.is_severe(storm)
    use_zones(monkeypatch, [storm])
    safe, reason = theatre_rules.is_path_safe_to_base(*START)
    assert not safe and "Storm cell" in reason and "WEATHER" in reason
    route = theatre_rules.plan_safe_route(*START)
    assert route and len(route["waypoints"]) >= 3
    for a, b in zip(route["waypoints"], route["waypoints"][1:]):
        assert not line_segment_intersects_circle(*a, *b, *storm["center"], storm["radius_m"])


def test_rain_within_limits_does_not_block_rtl(monkeypatch):
    rain = wx_zone("RAIN")
    assert not weather.is_severe(rain)
    use_zones(monkeypatch, [rain])
    safe, _ = theatre_rules.is_path_safe_to_base(*START)
    assert safe


def test_soft_zone_is_avoided_when_cheap_but_never_blocks():
    # A small rain cell on the line: cheap to skirt, so the route goes around it.
    small = (ON_THE_LINE[0], ON_THE_LINE[1], 300.0, "Rain", True)
    route = plan_route(START, GOAL, [small])
    assert route and len(route["waypoints"]) >= 3
    # A rain band covering the whole goal is still crossable (soft zones never block).
    huge = (GOAL[0], GOAL[1], 3000.0, "Rain", True)
    assert plan_route(START, GOAL, [huge]) is not None


def test_weather_effects_attribute_link_loss_and_battery_drain():
    storm = weather.effects(wx_zone("STORM"))
    rain = weather.effects(wx_zone("RAIN"))
    assert storm["rssi_loss"] > 0 and storm["drop_add"] > 0
    assert storm["battery_mult"] > rain["battery_mult"] > 1.0
    assert weather.effects(None)["battery_mult"] == 1.0


def test_weather_drifts_and_leaves_the_theatre(monkeypatch):
    z = wx_zone("RAIN", center=[44.330, 23.870])
    z["drift"] = [0.0, 0.001]  # fast eastward
    use_zones(monkeypatch, [z])
    gone = theatre_rules.drift_weather(10.0)
    assert gone == [z] and not z["is_active"]


def test_drone_in_storm_gets_one_alert_and_a_recommendation(monkeypatch):
    storm = wx_zone("STORM", center=START, radius=500.0, zid=901)
    use_zones(monkeypatch, [storm])
    d = simulator.drones[1]
    monkeypatch.setitem(d, "lat", START[0])
    monkeypatch.setitem(d, "lon", START[1])
    monkeypatch.setitem(d, "mode", "PATROL")
    monkeypatch.setitem(d, "weather_alert", None)
    with SessionLocal() as db:
        before = db.query(AuditLog).filter(AuditLog.event_type == "WEATHER_LIMIT_EXCEEDED").count()
        simulator._check_weather_limits(db, 1, d, storm)
        simulator._check_weather_limits(db, 1, d, storm)  # same cell: no second alert
        after = db.query(AuditLog).filter(AuditLog.event_type == "WEATHER_LIMIT_EXCEEDED").count()
        rec = (
            db.query(ActionRecommendation)
            .filter(ActionRecommendation.drone_id == 1, ActionRecommendation.status == "PENDING")
            .first()
        )
    assert after == before + 1
    # The storm it's in doesn't block the way home (flying home is the way out), so RTL is the advice.
    assert rec is not None and rec.recommended_action == "RETURN_TO_HOME"


def test_storm_around_the_drone_does_not_block_its_own_rtl(monkeypatch):
    use_zones(monkeypatch, [wx_zone("STORM", center=START, radius=500.0)])
    safe, _ = theatre_rules.is_path_safe_to_base(*START)
    assert safe


def test_weather_endpoints(client):
    res = client.post("/api/v1/simulation/trigger-weather-appear", params={"kind": "storm"})
    assert res.status_code == 200 and res.json()["zone"]["weather"] == "STORM"
    assert client.post("/api/v1/simulation/trigger-weather-appear", params={"kind": "hail"}).status_code == 400
    assert client.post("/api/v1/simulation/trigger-weather-clear").status_code == 200
