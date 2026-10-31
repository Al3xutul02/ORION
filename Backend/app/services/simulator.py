import asyncio
import logging
import math
import random
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Callable
from app.services.trust_evaluator import trust_evaluator, haversine_distance_m
from app.services.theatre_rules import theatre_rules
from app.services.aar_service import aar_service
from app.services.command_manager import command_manager
from app.core.database import SessionLocal
from app.models.recommendation import ActionRecommendation

logger = logging.getLogger("orion.simulator")

EGRESS_SPEED_DEG_PER_SEC = 0.00022  # ~24 m/s in lat/lon degrees


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
        self.next_random_event_at: float = 12.0
        self._last_event_kind: Optional[str] = None
        self._init_drones()

    def _init_drones(self):
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
        self.milestones_reached = {
            "spoofing_triggered": False,
            "rtl_blocked_recommended": False,
            "replay_attack_triggered": False,
            "sector_interference_marked": False,
            "report_ready": False
        }
        self.next_random_event_at = random.uniform(10.0, 15.0)

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

    def _issue_recommendation_for_drone(self, db, drone_id: int, reason: str):
        """Evaluates theatre rules for a degraded drone and creates a pending recommendation if none exists."""
        existing = (
            db.query(ActionRecommendation)
            .filter(ActionRecommendation.drone_id == drone_id, ActionRecommendation.status == "PENDING")
            .first()
        )
        d = self.drones[drone_id]
        rec = theatre_rules.evaluate_tactical_recommendation(
            drone_id=drone_id,
            drone_lat=d["lat"],
            drone_lon=d["lon"],
            trust_score=28.0,
            reason=reason
        )
        if not rec:
            return
        if existing:
            # Update existing pending recommendation if corridor/zone changed
            existing.blocked_action = rec["blocked_action"]
            existing.blocked_reason = rec["blocked_reason"]
            existing.recommended_action = rec["recommended_action"]
            existing.recommendation_details = rec["recommendation_details"]
            db.commit()
            return

        command_manager.create_recommendation(
            db=db,
            drone_id=drone_id,
            trigger_event=rec["trigger_event"],
            blocked_action=rec["blocked_action"],
            blocked_reason=rec["blocked_reason"],
            recommended_action=rec["recommended_action"],
            details=rec["recommendation_details"]
        )

    def execute_drone_action(self, drone_id: int, action: str):
        """Transitions a drone's flight state when the operator approves a recommendation or commands a drone."""
        if drone_id not in self.drones:
            return
        d = self.drones[drone_id]
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
            best_corr, _ = theatre_rules.find_best_corridor(d["lat"], d["lon"])
            corridors = theatre_rules.active_corridors()
            chosen = best_corr or (corridors[0] if corridors else None)
            wps = list(reversed(chosen["waypoints"])) if chosen else [[base_lat, base_lon]]
            d["egress_waypoints"] = wps
            if action == "LOITER_THEN_SAFE_CORRIDOR_RETREAT":
                d["mode"] = "LOITER"
                d["loiter_until"] = self.elapsed_time + 6.0
            else:
                d["mode"] = "CORRIDOR"
        elif action == "CONTINUE_PATROL":
            d["offset_angle"] = math.atan2(
                (d["lat"] - self.sector_center["lat"]) / 0.003,
                (d["lon"] - self.sector_center["lon"]) / 0.004
            )
            d["mode"] = "PATROL"
            d["spoofed"] = False
            d["jammed"] = False
            d["spoof_offset"] = (0.0, 0.0)
            d["safe_airspace_time"] = 0.0
            d["egress_waypoints"] = []
            trust_evaluator.drone_history.pop(drone_id, None)

    # -----------------------------------------------------------------
    # Battlefield Event Triggers (Used by both Random Loop & Manual API)
    # -----------------------------------------------------------------

    def trigger_gps_spoofing_drone2(self, db, target_drone_id: Optional[int] = None) -> Dict[str, Any]:
        if target_drone_id is None:
            # Pick a random non-spoofed patrolling drone (fallback to Drone 2)
            candidates = [d_id for d_id, d in self.drones.items() if not d["spoofed"] and d["mode"] == "PATROL"]
            target_drone_id = random.choice(candidates) if candidates else 2

        d = self.drones[target_drone_id]
        d["spoofed"] = True
        off_lat = random.choice([-1, 1]) * random.uniform(0.0038, 0.0052)
        off_lon = random.choice([-1, 1]) * random.uniform(0.0035, 0.0050)
        d["spoof_offset"] = (off_lat, off_lon)
        d["lat"] += off_lat
        d["lon"] += off_lon
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
        affected = random.sample(patrolling, k=min(2, len(patrolling))) if len(patrolling) >= 2 else [1, 3]
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
            operator_id="ORION_THEATRE_INTEL"
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
            operator_id="ORION_THEATRE_INTEL"
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

    def trigger_random_event(self, db) -> Dict[str, Any]:
        """Selects and fires a contextually appropriate random battlefield event."""
        active_corridors = len(theatre_rules.active_corridors())
        active_dangers = len(theatre_rules.active_danger_zones())

        weights: List[Tuple[str, float]] = [
            ("spoofing", 1.4),
            ("jammer", 1.1 if active_dangers < 4 else 0.4),
            ("danger_appear", 1.3 if active_dangers < 4 else 0.2),
            ("danger_disappear", 1.5 if active_dangers >= 3 else 0.4),
            ("corridor_appear", 1.4 if active_corridors < 2 else 0.8),
            ("corridor_disappear", 1.1 if active_corridors >= 2 else 0.4),
            ("replay", 0.9),
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

        if mode == "LOITER":
            if d_data["egress_waypoints"] and self.elapsed_time >= d_data["loiter_until"]:
                d_data["mode"] = "CORRIDOR"
            return

        if mode in ("CORRIDOR", "RTL"):
            wps = d_data["egress_waypoints"]
            if not wps:
                d_data["mode"] = "PATROL"
                return
            target_lat, target_lon = wps[0]
            dlat = target_lat - d_data["lat"]
            dlon = target_lon - d_data["lon"]
            dist_deg = math.hypot(dlat, dlon)
            step = EGRESS_SPEED_DEG_PER_SEC * dt
            if dist_deg <= step:
                d_data["lat"] = target_lat
                d_data["lon"] = target_lon
                wps.pop(0)
                if not wps:
                    d_data["mode"] = "LANDED"
                    d_data["spoofed"] = False
                    d_data["jammed"] = False
                    d_data["landed_until"] = self.elapsed_time + 10.0
                    aar_service.log_event(
                        db=db,
                        event_type="DRONE_RECOVERED",
                        drone_id=d_id,
                        details={
                            "location": "Base Forward Alpha",
                            "via": "Direct Return-to-Home" if mode == "RTL" else "Safe Corridor Egress",
                            "mission_time_s": self.elapsed_time
                        },
                        operator_id="SYSTEM"
                    )
            else:
                d_data["lat"] += (dlat / dist_deg) * step
                d_data["lon"] += (dlon / dist_deg) * step
                d_data["heading"] = (math.degrees(math.atan2(dlon, dlat)) + 360) % 360
            return

        # Default: PATROL mode
        angular_speed = 0.08
        d_data["offset_angle"] += angular_speed * dt
        patrol_radius_lat = 0.003
        patrol_radius_lon = 0.004

        nominal_lat = self.sector_center["lat"] + patrol_radius_lat * math.sin(d_data["offset_angle"])
        nominal_lon = self.sector_center["lon"] + patrol_radius_lon * math.cos(d_data["offset_angle"])

        if d_data["spoofed"]:
            off_lat, off_lon = d_data.get("spoof_offset", (0.0042, 0.0038))
            d_data["lat"] = nominal_lat + off_lat
            d_data["lon"] = nominal_lon + off_lon
        else:
            d_data["lat"] = nominal_lat
            d_data["lon"] = nominal_lon

        d_data["heading"] = math.degrees(d_data["offset_angle"]) % 360

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
        # Recalibrate faster (3.5s) when actively stabilizing in LOITER/CORRIDOR/RTL, or 6s in PATROL.
        recal_threshold = 3.5 if d_data["mode"] in ("LOITER", "CORRIDOR", "RTL") else 6.0
        d_data["safe_airspace_time"] = d_data.get("safe_airspace_time", 0.0) + dt

        if d_data["safe_airspace_time"] >= recal_threshold:
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
                rec.status = "EXECUTED"
            if pending:
                db.commit()

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
                if self.elapsed_time >= self.next_random_event_at:
                    self.next_random_event_at = self.elapsed_time + random.uniform(12.0, 18.0)
                    self.trigger_random_event(db)

                # -------------------------------------------------------------
                # Drone Physics & Telemetry Generation
                # -------------------------------------------------------------
                fleet_telemetry: List[Dict[str, Any]] = []
                drone_states: List[Dict[str, Any]] = []
                dt = 1.0 / self.tick_rate_hz

                for d_id, d_data in self.drones.items():
                    self._move_drone(db, d_id, d_data, dt)
                    self._update_drone_recalibration(db, d_id, d_data, dt)

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

                    mode = d_data["mode"]
                    flight_mode = "GUIDED" if mode == "PATROL" else mode
                    speed = 0.0 if mode in ("LOITER", "LANDED") else (22.0 if mode in ("CORRIDOR", "RTL") else d_data["speed"])

                    telem = {
                        "drone_id": d_id,
                        "latitude": d_data["lat"],
                        "longitude": d_data["lon"],
                        "altitude": 0.0 if mode == "LANDED" else d_data["alt"],
                        "ground_speed": speed,
                        "heading": d_data["heading"],
                        "fix_type": fix_type,
                        "satellites_visible": sats,
                        "eph": eph,
                        "battery_remaining": max(20.0, 100.0 - ((self.elapsed_time * 0.08) % 80.0)),
                        "drop_rate_comm": drop_rate,
                        "rssi": rssi,
                        "noise": 15.0,
                        "flight_mode": flight_mode,
                        "is_armed": mode != "LANDED"
                    }
                    fleet_telemetry.append(telem)

                # Run trust evaluator across fleet
                for telem in fleet_telemetry:
                    d_id = telem["drone_id"]
                    score_breakdown = trust_evaluator.evaluate(
                        drone_id=d_id,
                        telemetry=telem,
                        peer_telemetries=fleet_telemetry,
                        command_valid=True
                    )

                    # Keep spoofed drone in RED while spoofing persists
                    if self.drones[d_id]["spoofed"]:
                        score_breakdown.trust_score = min(score_breakdown.trust_score, 32.0)
                        score_breakdown.trust_status = "RED"
                        score_breakdown.imu_score = 10.0
                        score_breakdown.consensus_score = 15.0
                        score_breakdown.uncertainty_radius_m = max(score_breakdown.uncertainty_radius_m, 180.0)
                        score_breakdown.reason = "Impossible position jump; Neighbor consensus mismatch (diverged from patrol formation)"

                    state_dict = {
                        **telem,
                        "trust_score": score_breakdown.trust_score,
                        "trust_status": score_breakdown.trust_status,
                        "uncertainty_radius_m": score_breakdown.uncertainty_radius_m,
                        "reason": score_breakdown.reason,
                        "scores": score_breakdown.model_dump(mode="json"),
                        "last_updated": datetime.now(timezone.utc).isoformat()
                    }
                    drone_states.append(state_dict)

                # Broadcast only active zones to frontend map
                ws_payload = {
                    "type": "FLEET_UPDATE",
                    "elapsed_time": self.elapsed_time,
                    "active_sector_interference": trust_evaluator.localized_interference_active,
                    "zones": theatre_rules.active_zones(),
                    "drones": drone_states
                }
                await self.broadcast(ws_payload)

            except Exception as e:
                logger.error("Error in simulator loop: %s", e)
            finally:
                db.close()

            elapsed = time.time() - t0
            await asyncio.sleep(max(0.01, interval - elapsed))


simulator = OrionFleetSimulator()
