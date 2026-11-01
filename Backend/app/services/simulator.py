import asyncio
import logging
import math
import random
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Callable
from app.services.trust_evaluator import trust_evaluator, haversine_distance_m
from app.services.theatre_rules import theatre_rules, line_segment_intersects_circle
from app.services.aar_service import aar_service
from app.services import mesh, patrol, weather
from app.services.mavlink_bridge import mavlink_input, mavlink_output
from app.services.command_manager import command_manager
from app.core.database import SessionLocal
from app.models.recommendation import ActionRecommendation
from app.models.audit import AuditLog

logger = logging.getLogger("orion.simulator")

EGRESS_SPEED_DEG_PER_SEC = 0.00022  # ~24 m/s in lat/lon degrees
PATROL_ANGULAR_SPEED = 0.08  # rad/s around the orbit; patrol.py only ever slows a drone below it
PATROL_RADIUS_LAT = 0.003    # orbit half-axes in degrees (~330 m x ~320 m)
PATROL_RADIUS_LON = 0.004


class OrionFleetSimulator:
    """
    Live Dynamic Battlefield Simulator for ORION Ground Control Station.
    Emits MAVLink 2 telemetry at 2Hz and periodically injects randomized battlefield events:
    - GPS Spoofing on a random drone
    - Localized EW Jammer appearing in a random location
    - New Safe Corridor appearing
    - Old Safe Corridor becoming compromised (disappearing)
    - New Danger Zone (Threat / Interference) appearing
    - Old Danger Zone disappearing / cleared
    - Adversary Command Replay attack
    """

    def __init__(self, tick_rate_hz: float = 2.0):
        self.tick_rate_hz = tick_rate_hz
        self.is_running = False
        self.elapsed_time = 0.0
        self.start_timestamp: Optional[float] = None
        self._task: Optional[asyncio.Task] = None

        # Callbacks for WebSocket broadcasting
        self.listeners: List[Callable[[Dict[str, Any]], Any]] = []

        # Reference anchor
        self.sector_center = {"lat": 44.3350, "lon": 23.8300, "alt": 120.0}

        self.drones: Dict[int, Dict[str, Any]] = {}
        self.milestones_reached: Dict[str, bool] = {}
        self.random_interval_min: float = 12.0
        self.random_interval_max: float = 18.0
        self.next_random_event_at: float = 12.0
        self.random_events_enabled: bool = True
        self._last_event_kind: Optional[str] = None
        self._next_drone_id: int = 5
        self._init_drones()

    def _init_drones(self):
        self._next_drone_id = 5
        self.drones = {
            1: {
                "lat": 44.3350, "lon": 23.8260, "alt": 120.0, "heading": 0.0, "speed": 12.0,
                "offset_angle": 0.0, "spoofed": False, "spoof_offset": (0.0, 0.0),
                "jammed": False, "mode": "PATROL", "loiter_until": 0.0,
                "egress_waypoints": [], "landed_until": 0.0, "safe_airspace_time": 0.0
            },
            2: {
                "lat": 44.3380, "lon": 23.8300, "alt": 120.0, "heading": 90.0, "speed": 12.0,
                "offset_angle": math.pi / 2, "spoofed": False, "spoof_offset": (0.0, 0.0),
                "jammed": False, "mode": "PATROL", "loiter_until": 0.0,
                "egress_waypoints": [], "landed_until": 0.0, "safe_airspace_time": 0.0
            },
            3: {
                "lat": 44.3350, "lon": 23.8340, "alt": 120.0, "heading": 180.0, "speed": 12.0,
                "offset_angle": math.pi, "spoofed": False, "spoof_offset": (0.0, 0.0),
                "jammed": False, "mode": "PATROL", "loiter_until": 0.0,
                "egress_waypoints": [], "landed_until": 0.0, "safe_airspace_time": 0.0
            },
            4: {
                "lat": 44.3320, "lon": 23.8300, "alt": 120.0, "heading": 270.0, "speed": 12.0,
                "offset_angle": 3 * math.pi / 2, "spoofed": False, "spoof_offset": (0.0, 0.0),
                "jammed": False, "mode": "PATROL", "loiter_until": 0.0,
                "egress_waypoints": [], "landed_until": 0.0, "safe_airspace_time": 0.0
            },
        }
        for d in self.drones.values():
            # Start exactly on the orbit at their slot (D1 east, D2 north, D3 west, D4 south),
            # evenly spread, instead of crossing the sector to reach it.
            d["lat"] = self.sector_center["lat"] + 0.003 * math.sin(d["offset_angle"])
            d["lon"] = self.sector_center["lon"] + 0.004 * math.cos(d["offset_angle"])
            d["on_orbit"] = True
        self._patrol_members = frozenset(self.drones)  # the starting formation
        self.milestones_reached = {
            "spoofing_triggered": False,
            "rtl_blocked_recommended": False,
            "replay_attack_triggered": False,
            "sector_interference_marked": False,
            "report_ready": False
        }
        self.next_random_event_at = random.uniform(10.0, 15.0)

    @property
    def spoofing_active_drone_2(self) -> bool:
        return any(d.get("spoofed", False) for d in self.drones.values())

    @property
    def sector_interference_active(self) -> bool:
        return any(d.get("jammed", False) for d in self.drones.values()) or trust_evaluator.localized_interference_active

    @staticmethod
    def _reported_position(d: Dict[str, Any]) -> tuple:
        """
        Position the drone *reports* (its GPS fix). "lat"/"lon" are always the true airframe
        position used for physics and hazard exposure; spoofing only shifts the reported fix.
        """
        if d.get("spoofed"):
            off_lat, off_lon = d.get("spoof_offset", (0.0, 0.0))
            return d["lat"] + off_lat, d["lon"] + off_lon
        return d["lat"], d["lon"]

    def get_telemetry(self, drone_id: int) -> Optional[Dict[str, Any]]:
        """
        Generates the MAVLink 2 perceived telemetry for a drone.
        Always reports the perceived GPS fix (_reported_position), never secret ground-truth.
        """
        if drone_id not in self.drones:
            return None
        d_data = self.drones[drone_id]
        mode = d_data["mode"]
        rep_lat, rep_lon = self._reported_position(d_data)
        flight_mode = "GUIDED" if mode == "PATROL" else mode
        speed = 0.0 if mode in ("LOITER", "LANDED") else (22.0 if mode in ("CORRIDOR", "RTL", "ROUTE") else d_data.get("speed", 12.0))
        if mode == "LOITER" and d_data.get("repositioning"):
            speed = 12.0  # stepping off the patrol orbit before it holds

        fix_type = 3
        sats = 12
        eph = round(random.uniform(0.9, 1.2), 2)
        drop_rate = round(random.uniform(0.2, 0.8), 1)
        rssi = round(random.uniform(92.0, 98.0), 1)

        if d_data["spoofed"]:
            sats = 4
            eph = 4.2
            fix_type = 2

        if d_data["jammed"]:
            sats = 3
            fix_type = 1
            eph = 6.0
            drop_rate = 35.0
            rssi = 25.0

        wx = d_data.get("weather_now")
        if wx:
            wx_fx = weather.effects(wx)
            drop_rate = round(drop_rate + wx_fx["drop_add"], 1)
            rssi = round(max(0.0, rssi - wx_fx["rssi_loss"]), 1)
            eph = round(eph + wx_fx["eph_add"], 2)

        battery_val = d_data.get("battery_used")
        if battery_val is None:
            battery_remaining = max(20.0, 100.0 - ((self.elapsed_time * 0.08) % 80.0))
        else:
            battery_remaining = max(20.0, round(100.0 - battery_val, 1))

        target_waypoints = []
        eta_s = None
        if mode in ("CORRIDOR", "RTL", "ROUTE") and d_data.get("egress_waypoints"):
            target_waypoints = [list(wp) for wp in d_data["egress_waypoints"]]
            total_dist_m = 0.0
            cur_p = (d_data["lat"], d_data["lon"])
            for wp in target_waypoints:
                total_dist_m += math.hypot((wp[0] - cur_p[0]) * 111139.0, (wp[1] - cur_p[1]) * 111139.0 * math.cos(math.radians(cur_p[0])))
                cur_p = (wp[0], wp[1])
            curr_speed = max(speed, 1.0)
            eta_s = int(round(total_dist_m / curr_speed))
        elif mode == "PATROL" and not d_data.get("on_orbit", True):
            pz = theatre_rules.get_zone(d_data.get("patrol_zone_id", 100))
            if pz and pz.get("center"):
                target_waypoints = [list(pz["center"])]
                dist_m = math.hypot((pz["center"][0] - d_data["lat"]) * 111139.0, (pz["center"][1] - d_data["lon"]) * 111139.0 * math.cos(math.radians(d_data["lat"])))
                eta_s = int(round(dist_m / max(speed, 1.0)))
        elif mode == "LOITER" and d_data.get("repositioning") and d_data.get("target_point"):
            target_waypoints = [list(d_data["target_point"])]
            tp = d_data["target_point"]
            dist_m = math.hypot((tp[0] - d_data["lat"]) * 111139.0, (tp[1] - d_data["lon"]) * 111139.0 * math.cos(math.radians(d_data["lat"])))
            eta_s = int(round(dist_m / max(speed, 1.0)))

        return {
            "drone_id": drone_id,
            "latitude": rep_lat,
            "longitude": rep_lon,
            "altitude": 0.0 if mode == "LANDED" else d_data["alt"],
            "ground_speed": speed,
            "heading": d_data.get("heading", 0.0),
            "fix_type": fix_type,
            "satellites_visible": sats,
            "eph": eph,
            "battery_remaining": battery_remaining,
            "drop_rate_comm": drop_rate,
            "rssi": rssi,
            "noise": 15.0,
            "flight_mode": flight_mode,
            "patrol_zone_id": d_data.get("patrol_zone_id", 100),
            "is_armed": mode != "LANDED",
            "target_waypoints": target_waypoints,
            "eta_s": eta_s,
        }

    def subscribe(self, callback: Callable[[Dict[str, Any]], Any]):
        self.listeners.append(callback)

    def unsubscribe(self, callback: Callable[[Dict[str, Any]], Any]):
        if callback in self.listeners:
            self.listeners.remove(callback)

    async def broadcast(self, data: Dict[str, Any]):
        for listener in self.listeners:
            try:
                res = listener(data)
                if asyncio.iscoroutine(res):
                    await res
            except Exception as e:
                logger.error("Error in simulator broadcast listener: %s", e)

    def start(self):
        if not self.is_running:
            self.is_running = True
            self.start_timestamp = time.time() - self.elapsed_time
            self._task = asyncio.create_task(self._run_loop())
            logger.info("ORION Live Battlefield Simulator started.")

    def stop(self):
        self.is_running = False
        if self._task:
            self._task.cancel()
            self._task = None
        logger.info("ORION Live Battlefield Simulator stopped.")

    def reset(self):
        self.stop()
        self.elapsed_time = 0.0
        self.start_timestamp = None
        theatre_rules.reset_zones()
        trust_evaluator.drone_history.clear()
        trust_evaluator.affected_drones_in_sector.clear()
        trust_evaluator.localized_interference_active = False
        self._init_drones()
        with SessionLocal() as db:
            db.query(ActionRecommendation).delete()
            db.query(AuditLog).delete()
            db.commit()
            aar_service.log_event(
                db=db,
                event_type="SYSTEM_INITIALIZED",
                drone_id=None,
                details={
                    "system": "ORION Ground Control Station",
                    "mode": "LIVE_SIMULATION",
                    "description": "Mission ledger reset and initialized",
                    "mission_time_s": 0.0,
                },
                operator_id="SYSTEM",
            )
        self.next_random_event_at = random.uniform(self.random_interval_min, self.random_interval_max)

    def set_random_interval(self, min_s: float, max_s: float, enabled: Optional[bool] = None):
        self.random_interval_min = float(min_s)
        self.random_interval_max = float(max_s)
        if enabled is not None:
            self.random_events_enabled = bool(enabled)
        remaining = self.next_random_event_at - self.elapsed_time
        if remaining > max_s or remaining < 0:
            self.next_random_event_at = self.elapsed_time + random.uniform(min_s, max_s)
        logger.info("ORION random battlefield event interval set to [%.1fs, %.1fs] (enabled=%s)", min_s, max_s, self.random_events_enabled)

    def set_random_events_enabled(self, enabled: bool):
        self.random_events_enabled = bool(enabled)
        if self.random_events_enabled:
            remaining = self.next_random_event_at - self.elapsed_time
            if remaining <= 0 or remaining > self.random_interval_max:
                self.next_random_event_at = self.elapsed_time + random.uniform(self.random_interval_min, self.random_interval_max)
        logger.info("ORION random battlefield events %s", "enabled" if self.random_events_enabled else "disabled")

    def _issue_recommendation_for_drone(self, db, drone_id: int, reason: str):
        """Evaluates theatre rules for a drone and creates a pending recommendation if needed."""
        existing = (
            db.query(ActionRecommendation)
            .filter(ActionRecommendation.drone_id == drone_id, ActionRecommendation.status == "PENDING")
            .first()
        )
        d = self.drones[drone_id]
        # Theatre rules run on the GCS, so they only know the reported position.
        rep_lat, rep_lon = self._reported_position(d)
        is_recalibration = reason == "Sensors recalibrated in safe airspace"
        current_trust = 95.0 if is_recalibration else 28.0
        rec = theatre_rules.evaluate_tactical_recommendation(
            drone_id=drone_id,
            drone_lat=rep_lat,
            drone_lon=rep_lon,
            trust_score=current_trust,
            reason=reason,
            flight_mode=d["mode"]
        )
        if not rec:
            return
        if existing:
            # Update existing pending recommendation if corridor/zone/state changed
            existing.trigger_event = rec["trigger_event"]
            existing.blocked_action = rec["blocked_action"]
            existing.blocked_reason = rec["blocked_reason"]
            existing.recommended_action = rec["recommended_action"]
            existing.recommendation_details = rec["recommendation_details"]
            existing.reason = rec.get("reason")
            db.commit()
            return

        command_manager.create_recommendation(
            db=db,
            drone_id=drone_id,
            trigger_event=rec["trigger_event"],
            blocked_action=rec["blocked_action"],
            blocked_reason=rec["blocked_reason"],
            recommended_action=rec["recommended_action"],
            details=rec["recommendation_details"],
            reason=rec.get("reason")
        )

    def move_patrol_zone(
        self,
        zone_id: int,
        new_lat: float,
        new_lon: float,
        db: Optional[Any] = None,
        operator_id: str = "operator_demo",
        path_type: str = "SAFE"
    ) -> Dict[str, Any]:
        """Moves an active PATROL zone to [new_lat, new_lon] and repositions all drones inside it."""
        old_zone = theatre_rules.get_zone(zone_id)
        if not old_zone or old_zone.get("zone_type") != "PATROL":
            for z in theatre_rules.zones:
                if z.get("id") == zone_id and z.get("zone_type") == "PATROL":
                    old_zone = z
                    break
        if not old_zone:
            return {"status": "ERROR", "message": f"Patrol zone {zone_id} not found"}

        old_center = list(old_zone.get("center", [0.0, 0.0]))
        updated_zone = theatre_rules.move_patrol_zone(zone_id, new_lat, new_lon)
        if not updated_zone:
            return {"status": "ERROR", "message": "Failed to update patrol zone center"}

        if zone_id == 100 or len(theatre_rules.active_patrol_zones()) == 1:
            self.sector_center = {"lat": updated_zone["center"][0], "lon": updated_zone["center"][1], "alt": 120.0}

        zone_drones = [d for d in self.drones.values() if d.get("patrol_zone_id") == zone_id]
        if not zone_drones and zone_id == 100:
            zone_drones = list(self.drones.values())

        for d in zone_drones:
            d["patrol_zone_id"] = zone_id
            d["on_orbit"] = False
            d["jammed"] = False
            d["spoofed"] = False
            d["safe_airspace_time"] = 10.0
            if "hold_point" in d:
                del d["hold_point"]
            rep_lat, rep_lon = self._reported_position(d)
            route = theatre_rules.plan_target_route((rep_lat, rep_lon), (new_lat, new_lon), path_type=path_type)
            d["mode"] = "ROUTE"
            d["target_mode"] = "PATROL"
            d["target_zone_id"] = zone_id
            d["route_dest"] = [new_lat, new_lon]
            d["path_type"] = path_type
            if route and len(route.get("waypoints", [])) > 1:
                d["egress_waypoints"] = [list(p) for p in route["waypoints"][1:]]
            else:
                d["egress_waypoints"] = [[new_lat, new_lon]]

        if db:
            from app.services.aar_service import aar_service
            aar_service.log_event(
                db=db,
                event_type="PATROL_ZONE_MOVED",
                drone_id=None,
                details={
                    "zone_id": zone_id,
                    "name": updated_zone["name"],
                    "old_center": old_center,
                    "new_center": updated_zone["center"],
                    "drones_count": len(zone_drones),
                },
                operator_id=operator_id
            )

        return {
            "status": "MOVED",
            "zone": updated_zone,
            "drones_count": len(zone_drones),
            "message": f"Patrol Zone '{updated_zone['name']}' moved to ({new_lat:.4f}, {new_lon:.4f}). {len(zone_drones)} drone(s) repositioning to new location."
        }

    def apply_zone_tactic(self, db, zone_id: int, tactic: str, operator_id: str = "operator_demo") -> Dict[str, Any]:
        res = theatre_rules.apply_patrol_tactic(zone_id, tactic)
        if res.get("status") == "ERROR":
            return res
        pz = theatre_rules.get_zone(zone_id)
        tactic_upper = tactic.upper()
        zone_drones = [d for d in self.drones.values() if d.get("patrol_zone_id") == zone_id]
        if not zone_drones and zone_id == 100:
            zone_drones = list(self.drones.values())

        if tactic_upper in ("TIGHT_MESH", "WIDE_RECON"):
            for d in zone_drones:
                d["on_orbit"] = False
                if d.get("mode") in ("LOITER", "GUIDED"):
                    d["mode"] = "PATROL"
        elif tactic_upper == "RESYNC_EQUIDISTANT":
            if zone_drones:
                step_angle = (2.0 * math.pi) / len(zone_drones)
                base_angle = zone_drones[0].get("offset_angle", 0.0)
                for idx, d in enumerate(zone_drones):
                    d["offset_angle"] = (base_angle + idx * step_angle) % (2.0 * math.pi)
                    d["patrol_rate"] = PATROL_ANGULAR_SPEED
                    d["on_orbit"] = False
                    if d.get("mode") in ("LOITER", "GUIDED"):
                        d["mode"] = "PATROL"
        elif tactic_upper == "EGRESS_CORRIDOR":
            for did, d in self.drones.items():
                if d.get("patrol_zone_id") == zone_id or (zone_id == 100 and d.get("patrol_zone_id") is None):
                    if d.get("mode") in ("PATROL", "LOITER"):
                        self.execute_drone_action(db, did, "SAFE_CORRIDOR_RETREAT", operator_id=operator_id)
        return res

    def execute_drone_action(self, drone_id: int, action: str, target_zone_id: Optional[int] = None, target_point: Optional[List[float]] = None, path_type: str = "SAFE"):
        """Transitions a drone's flight state when the operator approves a recommendation or commands a drone."""
        if drone_id not in self.drones:
            return
        d = self.drones[drone_id]
        d["safe_airspace_time"] = 0.0
        d["spoof_duration"] = 0.0
        base_lat = theatre_rules.home_base["lat"]
        base_lon = theatre_rules.home_base["lon"]

        if action == "RETURN_TO_HOME":
            d["mode"] = "RTL"
            d["egress_waypoints"] = [[base_lat, base_lon]]
        elif action == "LOITER":
            d["mode"] = "LOITER"
            d["loiter_until"] = float("inf")
            d["egress_waypoints"] = []
        elif action in ("SAFE_CORRIDOR_RETREAT", "LOITER_THEN_SAFE_CORRIDOR_RETREAT"):
            # The GCS plans from what it sees: the reported position.
            rep_lat, rep_lon = self._reported_position(d)
            best_corr, _ = theatre_rules.find_best_corridor(rep_lat, rep_lon)
            corridors = theatre_rules.active_corridors()
            chosen = best_corr or (corridors[0] if corridors else None)
            wps = list(reversed(chosen["waypoints"])) if chosen else [[base_lat, base_lon]]
            d["egress_waypoints"] = wps
            if action == "LOITER_THEN_SAFE_CORRIDOR_RETREAT":
                d["mode"] = "LOITER"
                d["loiter_until"] = self.elapsed_time + 6.0
            else:
                d["mode"] = "CORRIDOR"
        elif action == "SAFE_ROUTE_RETREAT":
            route = theatre_rules.plan_safe_route(d["lat"], d["lon"])
            if route:
                d["mode"] = "ROUTE"
                d["egress_waypoints"] = [list(p) for p in route["waypoints"][1:]]
            else:
                d["mode"] = "LOITER"
                d["loiter_until"] = float("inf")
                d["egress_waypoints"] = []
        elif action == "JOIN_PATROL":
            zid = target_zone_id or d.get("patrol_zone_id", 100)
            p_zone = theatre_rules.get_zone(zid)
            if not p_zone:
                pzs = theatre_rules.active_patrol_zones()
                p_zone = pzs[0] if pzs else None
            if p_zone:
                c_lat, c_lon = p_zone["center"]
                r_m = p_zone["radius_m"]
                ang = math.atan2(d["lat"] - c_lat, d["lon"] - c_lon)
                r_lat = r_m / 111139.0
                r_lon = r_m / (111139.0 * math.cos(math.radians(c_lat)))
                entry_lat = c_lat + r_lat * math.sin(ang)
                entry_lon = c_lon + r_lon * math.cos(ang)
                rep_lat, rep_lon = self._reported_position(d)
                route = theatre_rules.plan_target_route((rep_lat, rep_lon), (entry_lat, entry_lon), path_type=path_type)
                d["mode"] = "ROUTE"
                d["target_mode"] = "PATROL"
                d["target_zone_id"] = p_zone["id"]
                d["patrol_zone_id"] = p_zone["id"]
                d["path_type"] = path_type
                if route and len(route["waypoints"]) > 1:
                    d["egress_waypoints"] = [list(p) for p in route["waypoints"][1:]]
                else:
                    d["egress_waypoints"] = [[entry_lat, entry_lon]]
                d["offset_angle"] = ang

        elif action == "LOITER_AT":
            t_pt = target_point if target_point and len(target_point) == 2 else [d["lat"], d["lon"]]
            rep_lat, rep_lon = self._reported_position(d)
            route = theatre_rules.plan_target_route((rep_lat, rep_lon), (t_pt[0], t_pt[1]), path_type=path_type)
            d["mode"] = "ROUTE"
            d["target_mode"] = "LOITER"
            d["target_point"] = [float(t_pt[0]), float(t_pt[1])]
            d["path_type"] = path_type
            if route and len(route["waypoints"]) > 1:
                d["egress_waypoints"] = [list(p) for p in route["waypoints"][1:]]
            else:
                d["egress_waypoints"] = [[float(t_pt[0]), float(t_pt[1])]]

        elif action in ("TIGHT_MESH", "WIDE_RECON", "RESYNC_EQUIDISTANT", "EGRESS_CORRIDOR"):
            zid = target_zone_id or d.get("patrol_zone_id", 100)
            self.apply_zone_tactic(db, zid, action, operator_id=operator_id)
        elif action == "CONTINUE_PATROL":
            pz = theatre_rules.get_zone(d.get("patrol_zone_id", 100))
            if not pz:
                pzs = theatre_rules.active_patrol_zones()
                pz = pzs[0] if pzs else None
            c_lat = pz["center"][0] if pz else self.sector_center["lat"]
            c_lon = pz["center"][1] if pz else self.sector_center["lon"]
            r_lat = PATROL_RADIUS_LAT if (pz and pz.get("id") == 100) else (r_m / 111139.0)
            r_lon = PATROL_RADIUS_LON if (pz and pz.get("id") == 100) else (r_m / (111139.0 * math.cos(math.radians(c_lat))))
            d["offset_angle"] = math.atan2(
                (d["lat"] - c_lat) / r_lat,
                (d["lon"] - c_lon) / r_lon
            )
            d["mode"] = "PATROL"
            d["spoofed"] = False
            d["jammed"] = False
            d["spoof_offset"] = (0.0, 0.0)
            d["safe_airspace_time"] = 0.0
            d["egress_waypoints"] = []
            d["target_mode"] = None
            trust_evaluator.drone_history.pop(drone_id, None)

    def deploy_drone(self, db: Optional[Any] = None, operator_id: str = "OPERATOR_1") -> Dict[str, Any]:
        """
        Deploys a new drone in the Base Forward zone (Base Forward Alpha).
        The drone starts loitering safely in the base forward zone, ready for operator commands.
        """
        drone_id = self._next_drone_id
        while drone_id in self.drones:
            drone_id += 1
        self._next_drone_id = drone_id + 1

        base_lat = theatre_rules.home_base["lat"]
        base_lon = theatre_rules.home_base["lon"]
        base_alt = 120.0

        # Small radial jitter (20m - 60m) so multiple base-deployed drones don't visually overlap perfectly
        angle = random.uniform(0.0, 2.0 * math.pi)
        dist_m = random.uniform(20.0, 60.0)
        dlat = (dist_m * math.cos(angle)) / 111139.0
        dlon = (dist_m * math.sin(angle)) / (111139.0 * math.cos(math.radians(base_lat)))
        lat = round(base_lat + dlat, 6)
        lon = round(base_lon + dlon, 6)

        self.drones[drone_id] = {
            "lat": lat,
            "lon": lon,
            "alt": base_alt,
            "heading": round(math.degrees(angle), 1),
            "speed": 0.0,
            "offset_angle": angle,
            "spoofed": False,
            "spoof_offset": (0.0, 0.0),
            "jammed": False,
            "mode": "LOITER",
            "loiter_until": float("inf"),
            "egress_waypoints": [],
            "landed_until": 0.0,
            "safe_airspace_time": 0.0,
            "patrol_zone_id": 100,
            "hold_point": [lat, lon],
            "on_orbit": False,
            "battery_used": 0.0,
        }

        if db:
            aar_service.log_event(
                db=db,
                event_type="DRONE_DEPLOYED",
                drone_id=drone_id,
                details={
                    "location": "Base Forward Alpha",
                    "coordinates": [lat, lon],
                    "description": f"Drone {drone_id} deployed in Base Forward zone (mode: LOITER)",
                    "mission_time_s": self.elapsed_time,
                },
                operator_id=operator_id,
            )

        logger.info("Drone %d deployed in Base Forward zone at (%.6f, %.6f)", drone_id, lat, lon)
        return {
            "status": "DRONE_DEPLOYED",
            "drone_id": drone_id,
            "location": [lat, lon],
            "mode": "LOITER",
        }

    # -----------------------------------------------------------------
    # Battlefield Event Triggers (Used by both Random Loop & Manual API)
    # -----------------------------------------------------------------

    def trigger_gps_spoofing_drone2(self, db, target_drone_id: Optional[int] = None) -> Dict[str, Any]:
        if target_drone_id is None:
            # Pick a random non-spoofed patrolling drone (fallback to Drone 2 if available, or any available)
            candidates = [d_id for d_id, d in self.drones.items() if not d["spoofed"] and d["mode"] == "PATROL"]
            if candidates:
                target_drone_id = random.choice(candidates)
            elif 2 in self.drones:
                target_drone_id = 2
            elif self.drones:
                target_drone_id = random.choice(list(self.drones.keys()))
            else:
                return {"status": "NO_DRONES_AVAILABLE"}

        if target_drone_id not in self.drones:
            return {"status": "DRONE_NOT_FOUND", "drone_id": target_drone_id}

        d = self.drones[target_drone_id]
        # Spoofing only falsifies the GPS fix: the airframe stays where it is ("lat"/"lon"),
        # while the reported position jumps by spoof_offset (see _reported_position).
        d["spoofed"] = True
        off_lat = random.choice([-1, 1]) * random.uniform(0.0038, 0.0052)
        off_lon = random.choice([-1, 1]) * random.uniform(0.0035, 0.0050)
        d["spoof_offset"] = (off_lat, off_lon)
        self.milestones_reached["spoofing_triggered"] = True

        aar_service.log_event(
            db=db,
            event_type="SPOOFING_ATTACK_INITIATED",
            drone_id=target_drone_id,
            details={
                "attack_vector": "GPS_SPOOFING_INJECTION",
                "target": f"Drone {target_drone_id}",
                "description": f"False ephemeris & sudden position jump injected on Drone {target_drone_id}",
                "mission_time_s": self.elapsed_time
            },
            operator_id="SIMULATOR"
        )
        self._issue_recommendation_for_drone(db, target_drone_id, f"GPS spoofing detected on Drone {target_drone_id}")
        return {"event": "SPOOFING", "drone_id": target_drone_id}

    def trigger_replay_attack(self, db) -> Dict[str, Any]:
        self.milestones_reached["replay_attack_triggered"] = True
        if not self.drones:
            return {"status": "NO_DRONES_AVAILABLE"}
        target_id = random.choice(list(self.drones.keys()))
        past_cmd = {
            "command": "RETURN_TO_HOME",
            "drone_id": target_id,
            "sequence": random.randint(1, 9),
            "params": {"altitude": 100, "mission_time_s": self.elapsed_time},
            "timestamp": time.time() - random.uniform(18.0, 45.0),
            "signature": f"replayed_sig_{random.randint(1000, 9999)}"
        }
        command_manager.receive_and_validate_command(db=db, command_data=past_cmd, operator_id="SIMULATED_ADVERSARY")
        return {"event": "REPLAY", "drone_id": target_id}

    def trigger_sector_interference(self, db) -> Dict[str, Any]:
        self.milestones_reached["sector_interference_marked"] = True
        # Pick 2 drones to experience localized EW jamming
        patrolling = [d_id for d_id, d in self.drones.items() if d["mode"] != "LANDED"]
        if not patrolling:
            if not self.drones:
                return {"status": "NO_DRONES_AVAILABLE"}
            patrolling = list(self.drones.keys())
        affected = random.sample(patrolling, k=min(2, len(patrolling)))
        for d_id in affected:
            self.drones[d_id]["jammed"] = True

        c_lat = sum(self.drones[i]["lat"] for i in affected) / len(affected)
        c_lon = sum(self.drones[i]["lon"] for i in affected) / len(affected)
        zone = theatre_rules.add_dynamic_interference_zone(
            name="Mobile EW Jammer Sector",
            center_lat=c_lat,
            center_lon=c_lon,
            radius_m=random.uniform(380.0, 440.0)
        )
        aar_service.log_event(
            db=db,
            event_type="ZONE_INTERFERENCE_MARKED",
            drone_id=affected[0],
            details={
                "zone_name": zone["name"],
                "affected_drones": affected,
                "action": f"Consensus: Drones {affected} lost GPS simultaneously. Dynamic EW zone mapped at ({c_lat:.4f}, {c_lon:.4f}).",
                "mission_time_s": self.elapsed_time
            },
            operator_id="ORION_CONSENSUS"
        )
        self._issue_recommendation_for_drone(db, affected[0], "Localized EW jamming detected")
        return {"event": "JAMMER", "zone": zone, "affected_drones": affected}

    def trigger_corridor_appear(self, db) -> Dict[str, Any]:
        new_corr = theatre_rules.spawn_safe_corridor()
        aar_service.log_event(
            db=db,
            event_type="SAFE_CORRIDOR_ESTABLISHED",
            drone_id=None,
            details={
                "corridor_id": new_corr["id"],
                "corridor_name": new_corr["name"],
                "description": f"New verified safe egress corridor opened: {new_corr['name']}",
                "mission_time_s": self.elapsed_time
            },
            operator_id="THEATRE_INTEL"
        )
        # Re-evaluate any degraded drones so they can use the newly opened corridor
        for d_id, d in self.drones.items():
            if d["spoofed"] or d["jammed"]:
                self._issue_recommendation_for_drone(db, d_id, "Safe corridor updated")
        return {"event": "CORRIDOR_APPEARED", "corridor": new_corr}

    def trigger_corridor_disappear(self, db) -> Dict[str, Any]:
        removed = theatre_rules.remove_safe_corridor()
        if not removed:
            # If no corridor was active, open one instead
            return self.trigger_corridor_appear(db)

        aar_service.log_event(
            db=db,
            event_type="SAFE_CORRIDOR_COMPROMISED",
            drone_id=None,
            details={
                "corridor_id": removed["id"],
                "corridor_name": removed["name"],
                "description": f"{removed['name']} is no longer safe due to hostile activity and has been closed.",
                "mission_time_s": self.elapsed_time
            },
            operator_id="THEATRE_INTEL"
        )
        # Update recommendations for any degraded drones
        for d_id, d in self.drones.items():
            if d["spoofed"] or d["jammed"]:
                self._issue_recommendation_for_drone(db, d_id, "Safe corridor compromised")
        return {"event": "CORRIDOR_DISAPPEARED", "corridor": removed}

    def trigger_danger_appear(self, db) -> Dict[str, Any]:
        new_danger = theatre_rules.spawn_danger_zone()
        aar_service.log_event(
            db=db,
            event_type="THREAT_ZONE_DETECTED",
            drone_id=None,
            details={
                "zone_id": new_danger["id"],
                "zone_name": new_danger["name"],
                "zone_type": new_danger["zone_type"],
                "radius_m": new_danger["radius_m"],
                "description": f"New danger zone detected: {new_danger['name']} ({new_danger['zone_type']})",
                "mission_time_s": self.elapsed_time
            },
            operator_id="THEATRE_INTEL"
        )
        # Check if any drone is inside or has its route affected
        for d_id, d in self.drones.items():
            dist = haversine_distance_m(d["lat"], d["lon"], new_danger["center"][0], new_danger["center"][1])
            if dist <= new_danger["radius_m"] * 1.2 or d["spoofed"] or d["jammed"]:
                if new_danger["zone_type"] == "INTERFERENCE" and dist <= new_danger["radius_m"]:
                    d["jammed"] = True
                self._issue_recommendation_for_drone(db, d_id, f"Hazard proximity: {new_danger['name']}")
        return {"event": "DANGER_APPEARED", "zone": new_danger}

    def trigger_danger_disappear(self, db) -> Dict[str, Any]:
        cleared = theatre_rules.remove_danger_zone()
        if not cleared:
            return self.trigger_danger_appear(db)

        # Un-jam drones if interference cleared
        for d_id, d in self.drones.items():
            if d["jammed"]:
                d["jammed"] = False
                aar_service.log_event(
                    db=db,
                    event_type="GPS_RESTORED",
                    drone_id=d_id,
                    details={"description": f"Drone {d_id} reacquired clean GPS lock after {cleared['name']} ceased.", "mission_time_s": self.elapsed_time},
                    operator_id="SYSTEM"
                )

        aar_service.log_event(
            db=db,
            event_type="THREAT_ZONE_CLEARED",
            drone_id=None,
            details={
                "zone_id": cleared["id"],
                "zone_name": cleared["name"],
                "description": f"Danger zone neutralized / cleared: {cleared['name']}",
                "mission_time_s": self.elapsed_time
            },
            operator_id="THEATRE_INTEL"
        )
        return {"event": "DANGER_DISAPPEARED", "zone": cleared}

    def trigger_weather_appear(self, db, kind: Optional[str] = None) -> Dict[str, Any]:
        zone = theatre_rules.spawn_weather_zone(kind)
        aar_service.log_event(
            db=db,
            event_type="WEATHER_CELL_DETECTED",
            drone_id=None,
            details={
                "zone": zone["name"],
                "description": f"{zone['name']} entering the theatre: {weather.describe(zone)}",
                "blocks_flight": weather.is_severe(zone),
                "mission_time_s": self.elapsed_time
            },
            operator_id="MET_SERVICE"
        )
        return {"event": "WEATHER_APPEARED", "zone": zone}

    def trigger_weather_clear(self, db) -> Dict[str, Any]:
        zone = theatre_rules.clear_weather_zone()
        if zone:
            aar_service.log_event(
                db=db,
                event_type="WEATHER_CLEARED",
                drone_id=None,
                details={"zone": zone["name"], "description": f"{zone['name']} has dissipated", "mission_time_s": self.elapsed_time},
                operator_id="MET_SERVICE"
            )
        return {"event": "WEATHER_CLEARED", "zone": zone}

    def _check_patrol_zone_hazards(self, db):
        """Monitors active patrol zones for intersecting EW jammers and issues fallback tactic recommendation."""
        for pz in theatre_rules.active_patrol_zones():
            if pz.get("shifted"):
                continue
            for j in theatre_rules.active_danger_zones():
                if j.get("zone_type") == "INTERFERENCE" and j.get("geometry_type") == "CIRCLE":
                    d_m = haversine_distance_m(pz["center"][0], pz["center"][1], j["center"][0], j["center"][1])
                    if d_m < (pz["radius_m"] + j["radius_m"]):
                        assigned = [d_id for d_id, d in self.drones.items() if d.get("patrol_zone_id") == pz["id"]]
                        lead_drone = assigned[0] if assigned else 1
                        existing = db.query(ActionRecommendation).filter(
                            ActionRecommendation.drone_id == lead_drone,
                            ActionRecommendation.trigger_event == "PATROL_ZONE_JAMMED",
                            ActionRecommendation.status == "PENDING"
                        ).first()
                        if not existing:
                            rec = ActionRecommendation(
                                drone_id=lead_drone,
                                trigger_event="PATROL_ZONE_JAMMED",
                                blocked_action="NOMINAL_PATROL_ORBIT",
                                blocked_reason=f"Nominal orbit crosses {j['name']}",
                                recommended_action="LOITER",
                                reason=(
                                    f"EW Jamming Zone ({j['name']}) intersects {pz['name']}. "
                                    "Action needed: Hold position or move patrol zone away from jammer boundary to clear airspace and maintain swarm communications."
                                ),
                                recommendation_details=(
                                    "1. Hold position (LOITER) to prevent flying into jammer. "
                                    "2. Operator moves patrol zone to clear airspace. "
                                    "3. Swarm automatically repositioning to new orbit."
                                ),
                                status="PENDING"
                            )
                            db.add(rec)
                            db.commit()
                            db.refresh(rec)
                            aar_service.log_event(
                                db=db,
                                event_type="PATROL_JAMMING_DETECTED",
                                drone_id=lead_drone,
                                details={
                                    "patrol_zone_id": pz["id"],
                                    "patrol_zone_name": pz["name"],
                                    "jammer_name": j["name"],
                                    "recommendation_id": rec.id
                                },
                                operator_id="ORION_THEATRE_RULES"
                            )

    def _check_weather_limits(self, db, d_id: int, d_data: Dict[str, Any], zone: Optional[Dict[str, Any]]):
        """Weather beyond the platform's limits: alert once per entry and recommend leaving."""
        if not zone or not weather.is_severe(zone) or d_data["mode"] in ("LANDED", "RTL", "CORRIDOR", "ROUTE"):
            if not zone or not weather.is_severe(zone):
                d_data["weather_alert"] = None
            return
        if d_data.get("weather_alert") == zone["id"]:
            return
        d_data["weather_alert"] = zone["id"]
        aar_service.log_event(
            db=db,
            event_type="WEATHER_LIMIT_EXCEEDED",
            drone_id=d_id,
            details={
                "zone": zone["name"],
                "reason": f"{zone['name']}: {weather.describe(zone)}. Leave the cell",
                "mission_time_s": self.elapsed_time
            },
            operator_id="ORION_THEATRE_RULES"
        )
        self._issue_recommendation_for_drone(db, d_id, f"Inside {zone['name']} beyond wind limit")

    def trigger_random_event(self, db) -> Dict[str, Any]:
        """Selects and fires a contextually appropriate random battlefield event."""
        active_corridors = len(theatre_rules.active_corridors())
        active_dangers = len(theatre_rules.active_danger_zones())
        active_weather = len(theatre_rules.active_weather_zones())

        weights: List[Tuple[str, float]] = [
            ("spoofing", 1.6),
            ("jammer", 1.4 if active_dangers < 4 else 0.5),
            ("replay", 1.1),
            ("weather_appear", 0.9 if active_weather < 2 else 0.1),
            ("weather_clear", 0.7 if active_weather >= 1 else 0.0),
        ]
        # Avoid repeating the exact same event type twice in a row
        filtered = [(k, w) for k, w in weights if k != self._last_event_kind]
        kinds = [k for k, _ in filtered]
        probs = [w for _, w in filtered]
        chosen = random.choices(kinds, weights=probs, k=1)[0]
        self._last_event_kind = chosen

        if chosen == "spoofing":
            return self.trigger_gps_spoofing_drone2(db, target_drone_id=None)
        elif chosen == "jammer":
            return self.trigger_sector_interference(db)
        elif chosen == "corridor_appear":
            return self.trigger_corridor_appear(db)
        elif chosen == "corridor_disappear":
            return self.trigger_corridor_disappear(db)
        elif chosen == "danger_appear":
            return self.trigger_danger_appear(db)
        elif chosen == "danger_disappear":
            return self.trigger_danger_disappear(db)
        elif chosen == "weather_appear":
            return self.trigger_weather_appear(db)
        elif chosen == "weather_clear":
            return self.trigger_weather_clear(db)
        else:
            return self.trigger_replay_attack(db)

    def _move_drone(self, db, d_id: int, d_data: Dict[str, Any], dt: float):
        mode = d_data["mode"]

        if mode == "LANDED":
            if self.elapsed_time >= d_data["landed_until"]:
                # Relaunch drone back to patrol after turnaround at base
                d_data["mode"] = "PATROL"
                d_data["spoofed"] = False
                d_data["jammed"] = False
                d_data["spoof_offset"] = (0.0, 0.0)
            return

        if mode != "LOITER":
            d_data.pop("hold_point", None)
            d_data["repositioning"] = False

        if mode == "LOITER":
            if d_data["egress_waypoints"] and self.elapsed_time >= d_data["loiter_until"]:
                d_data["mode"] = "CORRIDOR"
                return
            self._hold_off_orbit(d_data, dt)
            return

        if mode == "ROUTE" and d_data["egress_waypoints"]:
            path_type = d_data.get("path_type", "SAFE")
            if self._route_leg_blocked(d_data, path_type):
                # A zone moved onto the planned route: re-plan from here, or hold if nothing is safe.
                t_mode = d_data.get("target_mode")
                if t_mode == "PATROL":
                    pz = theatre_rules.get_zone(d_data.get("target_zone_id", 100))
                    dest = (pz["center"][0], pz["center"][1]) if pz else (self.sector_center["lat"], self.sector_center["lon"])
                elif t_mode == "LOITER" and d_data.get("target_point"):
                    dest = (d_data["target_point"][0], d_data["target_point"][1])
                else:
                    dest = (theatre_rules.home_base["lat"], theatre_rules.home_base["lon"])
                route = theatre_rules.plan_target_route((d_data["lat"], d_data["lon"]), dest, path_type=path_type)
                if route:
                    d_data["egress_waypoints"] = [list(p) for p in route["waypoints"][1:]]
                else:
                    d_data["mode"] = "LOITER"
                    d_data["loiter_until"] = float("inf")
                    d_data["egress_waypoints"] = []
                aar_service.log_event(
                    db=db,
                    event_type="ROUTE_REPLANNED",
                    drone_id=d_id,
                    details={
                        "reason": "A hazard zone now crosses the planned route",
                        "result": f"{len(route['waypoints']) - 1} legs, {route['length_m'] / 1000:.1f} km" if route else "No safe route: holding (LOITER)",
                        "mission_time_s": self.elapsed_time
                    },
                    operator_id="ORION_PATHFINDER"
                )
                return

        if mode in ("CORRIDOR", "RTL", "ROUTE"):
            wps = d_data["egress_waypoints"]
            if not wps:
                d_data["mode"] = "PATROL"
                return
            target_lat, target_lon = wps[0]
            # The autopilot steers by its (possibly spoofed) GPS fix: it drives its *believed*
            # position onto the waypoint, so the true airframe ends up offset by the spoof.
            off_lat, off_lon = d_data["spoof_offset"] if d_data["spoofed"] else (0.0, 0.0)
            target_lat -= off_lat
            target_lon -= off_lon
            dlat = target_lat - d_data["lat"]
            dlon = target_lon - d_data["lon"]
            dist_deg = math.hypot(dlat, dlon)
            step = EGRESS_SPEED_DEG_PER_SEC * dt
            if dist_deg <= step:
                d_data["lat"] = target_lat
                d_data["lon"] = target_lon
                wps.pop(0)
                if not wps:
                    t_mode = d_data.get("target_mode")
                    if t_mode == "PATROL":
                        d_data["mode"] = "PATROL"
                        d_data["patrol_zone_id"] = d_data.get("target_zone_id", 100)
                        d_data["target_mode"] = None
                        d_data["spoofed"] = False
                        d_data["jammed"] = False
                        pz = theatre_rules.get_zone(d_data["patrol_zone_id"])
                        pz_name = pz["name"] if pz else "Patrol Zone"
                        aar_service.log_event(
                            db=db,
                            event_type="DRONE_JOINED_PATROL",
                            drone_id=d_id,
                            details={
                                "zone_id": d_data["patrol_zone_id"],
                                "zone_name": pz_name,
                                "path_type": d_data.get("path_type", "SAFE"),
                                "mission_time_s": self.elapsed_time
                            },
                            operator_id="SYSTEM"
                        )
                    elif t_mode == "LOITER":
                        d_data["mode"] = "LOITER"
                        d_data["loiter_until"] = float("inf")
                        d_data["hold_point"] = d_data.get("target_point", [d_data["lat"], d_data["lon"]])
                        d_data["target_mode"] = None
                        aar_service.log_event(
                            db=db,
                            event_type="DRONE_LOITER_HOLD",
                            drone_id=d_id,
                            details={
                                "location": d_data["hold_point"],
                                "path_type": d_data.get("path_type", "SAFE"),
                                "mission_time_s": self.elapsed_time
                            },
                            operator_id="SYSTEM"
                        )
                    else:
                        via_desc = {"RTL": "Direct Return-to-Home", "ROUTE": "Computed safe route (A*)"}.get(mode, "Safe Corridor Egress")
                        aar_service.log_event(
                            db=db,
                            event_type="DRONE_RECOVERED",
                            drone_id=d_id,
                            details={
                                "location": "Base Forward Alpha",
                                "description": f"Drone {d_id} completed retreat to Base Forward Alpha and was recovered (disappeared).",
                                "via": via_desc,
                                "mission_time_s": self.elapsed_time
                            },
                            operator_id="SYSTEM"
                        )
                        pending = (
                            db.query(ActionRecommendation)
                            .filter(ActionRecommendation.drone_id == d_id, ActionRecommendation.status == "PENDING")
                            .all()
                        )
                        for rec in pending:
                            rec.status = "SUPERSEDED"
                        if pending:
                            db.commit()

                        trust_evaluator.drone_history.pop(d_id, None)
                        trust_evaluator.affected_drones_in_sector.discard(d_id)
                        del self.drones[d_id]
                        logger.info("Drone %d completed retreat to Base Forward zone and disappeared.", d_id)
                        return
            else:
                d_data["lat"] += (dlat / dist_deg) * step
                d_data["lon"] += (dlon / dist_deg) * step
                d_data["heading"] = (math.degrees(math.atan2(dlon, dlat)) + 360) % 360
            return

        # PATROL mode: the drone holds its orbit physically (true frame); spoofing only
        # shifts what it reports, which is applied in _reported_position().
        d_data["alt"] = self.sector_center["alt"]
        angular_speed = PATROL_ANGULAR_SPEED
        pz = theatre_rules.get_zone(d_data.get("patrol_zone_id", 100))
        if not pz:
            pzs = theatre_rules.active_patrol_zones()
            pz = pzs[0] if pzs else None
        c_lat = pz["center"][0] if pz else self.sector_center["lat"]
        c_lon = pz["center"][1] if pz else self.sector_center["lon"]
        r_m = pz["radius_m"] if pz else 350.0
        if pz and pz.get("id") == 100:
            scale = (pz.get("radius_m") or 350.0) / 350.0
            patrol_radius_lat = PATROL_RADIUS_LAT * scale
            patrol_radius_lon = PATROL_RADIUS_LON * scale
        else:
            patrol_radius_lat = r_m / 111139.0
            patrol_radius_lon = r_m / (111139.0 * math.cos(math.radians(c_lat)))

        target_lat = c_lat + patrol_radius_lat * math.sin(d_data["offset_angle"])
        target_lon = c_lon + patrol_radius_lon * math.cos(d_data["offset_angle"])

        dlat = target_lat - d_data["lat"]
        dlon = target_lon - d_data["lon"]
        dist_deg = math.hypot(dlat, dlon)
        step = EGRESS_SPEED_DEG_PER_SEC * dt

        if dist_deg > step * 1.5:
            # Smoothly fly back to the patrol orbit entry point instead of teleporting
            d_data["on_orbit"] = False
            d_data["lat"] += (dlat / dist_deg) * step
            d_data["lon"] += (dlon / dist_deg) * step
            d_data["heading"] = (math.degrees(math.atan2(dlon, dlat)) + 360) % 360
        else:
            d_data["on_orbit"] = True
            d_data["offset_angle"] += d_data.get("patrol_rate", angular_speed) * dt
            d_data["lat"] = c_lat + patrol_radius_lat * math.sin(d_data["offset_angle"])
            d_data["lon"] = c_lon + patrol_radius_lon * math.cos(d_data["offset_angle"])
            d_data["heading"] = math.degrees(d_data["offset_angle"]) % 360

    def _hold_off_orbit(self, d_data: Dict[str, Any], dt: float):
        """A loitering drone steps out of the patrol orbit's path (patrol.hold_point), at patrol speed."""
        center = (self.sector_center["lat"], self.sector_center["lon"])
        radii = (PATROL_RADIUS_LAT, PATROL_RADIUS_LON)
        if "hold_point" not in d_data:  # decided once, when the drone starts holding
            d_data["hold_point"] = patrol.hold_point(d_data["lat"], d_data["lon"], center, radii, self._hold_is_clear(d_data))
            if d_data["hold_point"] is None and patrol.on_orbit(d_data["lat"], d_data["lon"], center, radii):
                d_data["alt"] = self.sector_center["alt"] + patrol.HOLD_CLIMB_M
        target = d_data["hold_point"]
        if target is None:
            d_data["repositioning"] = False
            return
        dlat, dlon = target[0] - d_data["lat"], target[1] - d_data["lon"]
        dist_deg = math.hypot(dlat, dlon)
        step = EGRESS_SPEED_DEG_PER_SEC / 2 * dt  # patrol speed: no reason to rush
        if dist_deg <= step:
            d_data["lat"], d_data["lon"] = target
            d_data["repositioning"] = False
        else:
            d_data["lat"] += dlat / dist_deg * step
            d_data["lon"] += dlon / dist_deg * step
            d_data["heading"] = (math.degrees(math.atan2(dlon, dlat)) + 360) % 360
            d_data["repositioning"] = True

    def _hold_is_clear(self, d_data: Dict[str, Any]):
        """A hold point is clear if it is outside every hazard and the way there crosses none
        (hazards the drone is already inside don't count, it is leaving them anyway)."""
        lat, lon = d_data["lat"], d_data["lon"]
        zones = [
            z for z in theatre_rules.blocking_zones()
            if z.get("geometry_type") == "CIRCLE"
            and haversine_distance_m(lat, lon, *z["center"]) > z["radius_m"]
        ]

        def clear(t_lat: float, t_lon: float) -> bool:
            return not any(
                line_segment_intersects_circle(lat, lon, t_lat, t_lon, *z["center"], z["radius_m"]) for z in zones
            )
        return clear

    def _coordinate_patrol(self, db):
        """Keeps the drones on each patrol orbit evenly spaced; logs when one joins or leaves it."""
        zones_map: Dict[int, Dict[int, float]] = {}
        for i, d in self.drones.items():
            if d["mode"] == "PATROL" and d.get("on_orbit"):
                zid = d.get("patrol_zone_id", 100)
                zones_map.setdefault(zid, {})[i] = d["offset_angle"]

        for zid, on_orbit_group in zones_map.items():
            for i, rate in patrol.spacing_rates(on_orbit_group, PATROL_ANGULAR_SPEED).items():
                self.drones[i]["patrol_rate"] = rate

        on_orbit = {i: d["offset_angle"] for i, d in self.drones.items() if d["mode"] == "PATROL" and d.get("on_orbit")}
        members = frozenset(on_orbit)
        previous, self._patrol_members = self._patrol_members, members
        if members == previous:
            return
        joined, left = sorted(members - previous), sorted(previous - members)
        n = len(members)
        single = len(joined) + len(left) == 1  # then the log row already names the drone
        change = ("Joined the patrol orbit" if joined else "Left the patrol orbit") if single else ", ".join(
            [f"Drone {i} joined" for i in joined] + [f"Drone {i} left" for i in left]
        )
        aar_service.log_event(
            db=db,
            event_type="PATROL_REBALANCED",
            drone_id=(joined or left)[0] if single else None,
            details={
                "description": f"{change}: {n} drone(s) on patrol"
                + (f", re-spacing to {360 / n:.0f} deg apart" if n >= 2 else ""),
                "joined": joined,
                "left": left,
                "patrol_drones": sorted(members),
                "mission_time_s": self.elapsed_time,
            },
            operator_id="ORION_PATROL",
        )

    def _route_leg_blocked(self, d_data: Dict[str, Any], path_type: str = "SAFE") -> bool:
        """True when the leg the drone is flying now crosses a hazard it isn't already inside."""
        lat, lon = d_data["lat"], d_data["lon"]
        t_lat, t_lon = d_data["egress_waypoints"][0]
        # In RISKY mode, only THREAT zones block the leg!
        # In SAFE mode, all blocking danger zones block the leg.
        check_zones = (
            [z for z in theatre_rules.active_danger_zones() if z.get("zone_type") == "THREAT"]
            if path_type.upper() == "RISKY"
            else theatre_rules.blocking_zones()
        )
        for z in check_zones:
            if z.get("geometry_type") != "CIRCLE":
                continue
            c_lat, c_lon = z["center"]
            if haversine_distance_m(lat, lon, c_lat, c_lon) <= z["radius_m"]:
                continue
            if line_segment_intersects_circle(lat, lon, t_lat, t_lon, c_lat, c_lon, z["radius_m"]):
                return True
        return False

    def _update_drone_recalibration(self, db, d_id: int, d_data: Dict[str, Any], dt: float):
        """
        Checks whether a drone is inside an active hazard zone or in clean airspace.
        When a spoofed or jammed drone retreats via a safe corridor or loiters in clean airspace
        outside all active THREAT / INTERFERENCE zones for ~4 seconds, its onboard EKF/IMU
        recalibrates and restores clean 3D GPS lock automatically.
        """
        if d_data["mode"] == "LANDED":
            return

        inside_hazard = False
        for z in theatre_rules.active_danger_zones():
            if z.get("geometry_type") == "CIRCLE":
                dist = haversine_distance_m(d_data["lat"], d_data["lon"], z["center"][0], z["center"][1])
                if dist <= z["radius_m"]:
                    inside_hazard = True
                    if z["zone_type"] == "INTERFERENCE" and not d_data["jammed"]:
                        d_data["jammed"] = True
                        self._issue_recommendation_for_drone(db, d_id, f"Entered {z['name']}")
                    break

        if inside_hazard:
            d_data["safe_airspace_time"] = 0.0
            return

        if not (d_data["spoofed"] or d_data["jammed"]):
            d_data["safe_airspace_time"] = 0.0
            return

        # Drone is degraded (spoofed or jammed) AND outside all hazard zones.
        if d_data["mode"] == "PATROL":
            # In PATROL mode, cruising blind does not stabilize the EKF.
            # safe_airspace_time remains 0. The spoofing persists until operator commands LOITER/egress
            # or the adversary burst duration (25s) completes.
            d_data["safe_airspace_time"] = 0.0
            d_data["spoof_duration"] = d_data.get("spoof_duration", 0.0) + dt
            if d_data["spoof_duration"] < 25.0:
                return

            # Adversary spoofing transmission burst expired while still on patrol
            d_data["spoofed"] = False
            d_data["jammed"] = False
            d_data["spoof_offset"] = (0.0, 0.0)
            d_data["spoof_duration"] = 0.0
            trust_evaluator.drone_history.pop(d_id, None)

            aar_service.log_event(
                db=db,
                event_type="GPS_RESTORED",
                drone_id=d_id,
                details={
                    "description": f"Adversary spoofing signal ceased; Drone {d_id} restored clean 3D GPS lock.",
                    "mission_time_s": self.elapsed_time
                },
                operator_id="SYSTEM"
            )

            # Supersede pending recommendation since spoofing cleared
            pending = (
                db.query(ActionRecommendation)
                .filter(ActionRecommendation.drone_id == d_id, ActionRecommendation.status == "PENDING")
                .all()
            )
            for rec in pending:
                rec.status = "SUPERSEDED"
            if pending:
                db.commit()
            return

        # Active stabilization mode: LOITER, CORRIDOR, RTL, ROUTE
        d_data["spoof_duration"] = 0.0
        recal_threshold = 5.0  # 10s of steady holding/transit in safe airspace allows EKF to converge
        d_data["safe_airspace_time"] = d_data.get("safe_airspace_time", 0.0) + dt

        if d_data["safe_airspace_time"] >= recal_threshold:
            was_spoofed = d_data["spoofed"]
            if was_spoofed:
                # The EKF rejects the false fix: the reported position snaps back onto the true
                # airframe position ("lat"/"lon" never moved). Re-plan the route/corridor from there.
                if d_data["egress_waypoints"] and d_data["mode"] == "ROUTE":
                    route = theatre_rules.plan_safe_route(d_data["lat"], d_data["lon"])
                    d_data["egress_waypoints"] = [list(pt) for pt in route["waypoints"][1:]] if route else []
                elif d_data["egress_waypoints"] and d_data["mode"] in ("LOITER", "CORRIDOR"):
                    best_corr, _ = theatre_rules.find_best_corridor(d_data["lat"], d_data["lon"])
                    corridors = theatre_rules.active_corridors()
                    chosen = best_corr or (corridors[0] if corridors else None)
                    if chosen:
                        d_data["egress_waypoints"] = list(reversed(chosen["waypoints"]))

            d_data["spoofed"] = False
            d_data["jammed"] = False
            d_data["spoof_offset"] = (0.0, 0.0)
            d_data["safe_airspace_time"] = 0.0
            d_data["offset_angle"] = math.atan2(
                (d_data["lat"] - self.sector_center["lat"]) / 0.003,
                (d_data["lon"] - self.sector_center["lon"]) / 0.004
            )
            trust_evaluator.drone_history.pop(d_id, None)

            aar_service.log_event(
                db=db,
                event_type="GPS_RESTORED",
                drone_id=d_id,
                details={
                    "description": (
                        f"Drone {d_id} recalibrated onboard EKF/IMU in safe airspace ({d_data['mode']}) "
                        "and restored clean 3D GPS lock."
                    ),
                    "mission_time_s": self.elapsed_time
                },
                operator_id="SYSTEM"
            )

            # Resolve any still-pending recommendation for this drone since it is now recalibrated
            pending = (
                db.query(ActionRecommendation)
                .filter(ActionRecommendation.drone_id == d_id, ActionRecommendation.status == "PENDING")
                .all()
            )
            for rec in pending:
                rec.status = "SUPERSEDED"
            if pending:
                db.commit()

            # Recommend resuming patrol if holding in loiter/corridor/rtl in safe airspace
            if d_data["mode"] in ("LOITER", "CORRIDOR", "RTL", "ROUTE"):
                self._issue_recommendation_for_drone(db, d_id, "Sensors recalibrated in safe airspace")

    async def _run_loop(self):
        interval = 1.0 / self.tick_rate_hz
        while self.is_running:
            t0 = time.time()
            self.elapsed_time = round(time.time() - self.start_timestamp, 1)

            db = SessionLocal()
            try:
                # -------------------------------------------------------------
                # Periodic Random Battlefield Events in Live Mode
                # -------------------------------------------------------------
                if self.random_events_enabled and self.elapsed_time >= self.next_random_event_at:
                    self.next_random_event_at = self.elapsed_time + random.uniform(self.random_interval_min, self.random_interval_max)
                    self.trigger_random_event(db)

                self._check_patrol_zone_hazards(db)

                # -------------------------------------------------------------
                # Drone Physics & Telemetry Generation
                # -------------------------------------------------------------
                fleet_telemetry: List[Dict[str, Any]] = []
                drone_states: List[Dict[str, Any]] = []
                dt = 1.0 / self.tick_rate_hz

                for gone in theatre_rules.drift_weather(dt):
                    aar_service.log_event(
                        db=db,
                        event_type="WEATHER_CLEARED",
                        drone_id=None,
                        details={"zone": gone["name"], "description": f"{gone['name']} drifted out of the theatre", "mission_time_s": self.elapsed_time},
                        operator_id="MET_SERVICE"
                    )

                self._coordinate_patrol(db)
                for d_id, d_data in list(self.drones.items()):
                    self._move_drone(db, d_id, d_data, dt)
                    if d_id not in self.drones:
                        continue
                    self._update_drone_recalibration(db, d_id, d_data, dt)
                    wx = weather.weather_at(theatre_rules.active_weather_zones(), d_data["lat"], d_data["lon"], haversine_distance_m)
                    d_data["weather_now"] = wx
                    self._check_weather_limits(db, d_id, d_data, wx)
                    wx_fx = weather.effects(wx)
                    if d_data["mode"] != "LANDED":
                        d_data["battery_used"] = (d_data.get("battery_used", 0.0) + 0.08 * dt * wx_fx["battery_mult"]) % 80.0
                    telem = self.get_telemetry(d_id)
                    if telem:
                        fleet_telemetry.append({**telem, "source": "SIM"})

                # External MAVLink vehicles (SITL, real drones) join the fleet read-only.
                fleet_telemetry.extend(mavlink_input.snapshot())

                # Drone-to-drone mesh: neighbours range each other by radio and vote on whose GPS is lying.
                mesh_view = mesh.compute_mesh(
                    [
                        mesh.MeshNode(
                            drone_id=d_id,
                            true_pos=(d["lat"], d["lon"]),
                            reported_pos=self._reported_position(d),
                            online=d["mode"] != "LANDED",
                        )
                        for d_id, d in self.drones.items()
                    ],
                    haversine_distance_m,
                )

                # Run trust evaluator across fleet using perceived telemetry only
                for telem in fleet_telemetry:
                    d_id = telem["drone_id"]
                    peer_view = mesh_view.get(d_id)
                    score_breakdown = trust_evaluator.evaluate(
                        drone_id=d_id,
                        telemetry=telem,
                        peer_telemetries=fleet_telemetry,
                        command_valid=True,
                        mesh_score=peer_view["score"] if peer_view else None,
                        mesh_reason=mesh.describe(peer_view),
                    )

                    wx = self.drones.get(d_id, {}).get("weather_now")
                    if wx:
                        note = f"Weather: {wx['name']} ({weather.describe(wx)}), link/battery effects are weather, not EW"
                        nominal = score_breakdown.reason == "Sensors & consensus nominal"
                        score_breakdown.reason = note if nominal else f"{score_breakdown.reason}; {note}"
                    state_dict = {
                        **telem,
                        "trust_score": score_breakdown.trust_score,
                        "trust_status": score_breakdown.trust_status,
                        "uncertainty_radius_m": score_breakdown.uncertainty_radius_m,
                        "reason": score_breakdown.reason,
                        "scores": score_breakdown.model_dump(mode="json"),
                        "mesh": peer_view,
                        "last_updated": datetime.now(timezone.utc).isoformat()
                    }
                    drone_states.append(state_dict)

                # Publish the simulated drones as MAVLink vehicles (QGroundControl sees what they report).
                mavlink_output.publish([s for s in drone_states if s.get("source") == "SIM"])

                # Broadcast only active zones to frontend map
                ws_payload = {
                    "type": "FLEET_UPDATE",
                    "elapsed_time": self.elapsed_time,
                    "active_sector_interference": trust_evaluator.localized_interference_active,
                    "zones": theatre_rules.active_zones(),
                    "drones": drone_states,
                    "random_interval_min": self.random_interval_min,
                    "random_interval_max": self.random_interval_max,
                    "random_events_enabled": self.random_events_enabled,
                }
                await self.broadcast(ws_payload)

            except Exception as e:
                logger.error("Error in simulator loop: %s", e)
            finally:
                db.close()

            elapsed = time.time() - t0
            await asyncio.sleep(max(0.01, interval - elapsed))


simulator = OrionFleetSimulator()
