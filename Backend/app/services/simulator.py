import asyncio
import logging
import math
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Callable
from app.services.trust_evaluator import trust_evaluator
from app.services.theatre_rules import theatre_rules
from app.services.aar_service import aar_service
from app.services.command_manager import command_manager
from app.core.database import SessionLocal
from app.schemas.drone import DroneState

logger = logging.getLogger("orion.simulator")


class OrionFleetSimulator:
    """
    Fleet simulator for 4 drones patrolling a tactical sector.
    Emits MAVLink 2 telemetry and executes the deterministic 3-minute hackathon pitch scenario.
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

        # Drone states
        self.drones: Dict[int, Dict[str, Any]] = {
            1: {"lat": 44.3350, "lon": 23.8260, "alt": 120.0, "heading": 0.0, "speed": 12.0, "offset_angle": 0.0, "spoofed": False, "jammed": False},
            2: {"lat": 44.3380, "lon": 23.8300, "alt": 120.0, "heading": 90.0, "speed": 12.0, "offset_angle": math.pi / 2, "spoofed": False, "jammed": False},
            3: {"lat": 44.3350, "lon": 23.8340, "alt": 120.0, "heading": 180.0, "speed": 12.0, "offset_angle": math.pi, "spoofed": False, "jammed": False},
            4: {"lat": 44.3320, "lon": 23.8300, "alt": 120.0, "heading": 270.0, "speed": 12.0, "offset_angle": 3 * math.pi / 2, "spoofed": False, "jammed": False},
        }

        # Demo scenario checkpoint flags
        self.milestones_reached = {
            "spoofing_triggered": False,
            "rtl_blocked_recommended": False,
            "replay_attack_triggered": False,
            "sector_interference_marked": False,
            "report_ready": False
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
            self.start_timestamp = time.time()
            self._task = asyncio.create_task(self._run_loop())
            logger.info("ORION Fleet Simulator started.")

    def stop(self):
        self.is_running = False
        if self._task:
            self._task.cancel()
            self._task = None
        logger.info("ORION Fleet Simulator stopped.")

    def reset(self):
        self.stop()
        self.elapsed_time = 0.0
        self.start_timestamp = None
        self.milestones_reached = {k: False for k in self.milestones_reached}
        self.drones = {
            1: {"lat": 44.3350, "lon": 23.8260, "alt": 120.0, "heading": 0.0, "speed": 12.0, "offset_angle": 0.0, "spoofed": False, "jammed": False},
            2: {"lat": 44.3380, "lon": 23.8300, "alt": 120.0, "heading": 90.0, "speed": 12.0, "offset_angle": math.pi / 2, "spoofed": False, "jammed": False},
            3: {"lat": 44.3350, "lon": 23.8340, "alt": 120.0, "heading": 180.0, "speed": 12.0, "offset_angle": math.pi, "spoofed": False, "jammed": False},
            4: {"lat": 44.3320, "lon": 23.8300, "alt": 120.0, "heading": 270.0, "speed": 12.0, "offset_angle": 3 * math.pi / 2, "spoofed": False, "jammed": False},
        }

    # Manual triggers for demo
    def trigger_gps_spoofing_drone2(self, db):
        self.drones[2]["spoofed"] = True
        self.milestones_reached["spoofing_triggered"] = True
        aar_service.log_event(
            db=db,
            event_type="SPOOFING_ATTACK_INITIATED",
            drone_id=2,
            details={"attack_vector": "GPS_SPOOFING_INJECTION", "target": "Drone 2", "description": "False ephemeris and sudden position jump injected"},
            operator_id="SIMULATOR"
        )

    def trigger_replay_attack(self, db):
        self.milestones_reached["replay_attack_triggered"] = True
        # Create a past expired/duplicate command to test replay defense
        past_cmd = {
            "command": "RETURN_TO_HOME",
            "drone_id": 2,
            "sequence": 5,
            "params": {"altitude": 100},
            "timestamp": time.time() - 30.0,  # Expired
            "signature": "fabricated_or_replayed_signature_deadbeef1234"
        }
        command_manager.receive_and_validate_command(db=db, command_data=past_cmd, operator_id="SIMULATED_ADVERSARY")

    def trigger_sector_interference(self, db):
        self.drones[1]["jammed"] = True
        self.drones[3]["jammed"] = True
        self.milestones_reached["sector_interference_marked"] = True
        theatre_rules.add_dynamic_interference_zone(
            name="Localized EW Interference (Sector 4)",
            center_lat=44.3350,
            center_lon=23.8300,
            radius_m=650.0
        )
        aar_service.log_event(
            db=db,
            event_type="ZONE_INTERFERENCE_MARKED",
            drone_id=None,
            details={"sector": "Sector 4", "affected_drones": [1, 3], "action": "Dynamic EW zone mapped; patrol reallocated outside"},
            operator_id="ORION_CONSENSUS"
        )

    async def _run_loop(self):
        interval = 1.0 / self.tick_rate_hz
        while self.is_running:
            t0 = time.time()
            self.elapsed_time = round(time.time() - self.start_timestamp, 1)

            db = SessionLocal()
            try:
                # -------------------------------------------------------------
                # Scripted 3-Minute Hackathon Demo Timeline
                # -------------------------------------------------------------
                # 0:30 (30s): Spoofing GPS on Drone 2
                if self.elapsed_time >= 30.0 and not self.milestones_reached["spoofing_triggered"]:
                    self.trigger_gps_spoofing_drone2(db)

                # 1:00 (60s): ORION evaluates safe path & blocks RTL for Drone 2
                if self.elapsed_time >= 60.0 and not self.milestones_reached["rtl_blocked_recommended"]:
                    self.milestones_reached["rtl_blocked_recommended"] = True
                    rec = theatre_rules.evaluate_tactical_recommendation(
                        drone_id=2,
                        drone_lat=self.drones[2]["lat"],
                        drone_lon=self.drones[2]["lon"],
                        trust_score=28.0,
                        reason="GPS spoofing detected"
                    )
                    if rec:
                        command_manager.create_recommendation(
                            db=db,
                            drone_id=2,
                            trigger_event=rec["trigger_event"],
                            blocked_action=rec["blocked_action"],
                            blocked_reason=rec["blocked_reason"],
                            recommended_action=rec["recommended_action"],
                            details=rec["recommendation_details"]
                        )

                # 1:40 (100s): Replay attack simulation
                if self.elapsed_time >= 100.0 and not self.milestones_reached["replay_attack_triggered"]:
                    self.trigger_replay_attack(db)

                # 2:10 (130s): Sector-wide interference (Drone 1 and Drone 3 lose GPS)
                if self.elapsed_time >= 130.0 and not self.milestones_reached["sector_interference_marked"]:
                    self.trigger_sector_interference(db)

                # 2:40 (160s): Post-action report ready
                if self.elapsed_time >= 160.0 and not self.milestones_reached["report_ready"]:
                    self.milestones_reached["report_ready"] = True
                    aar_service.log_event(
                        db=db,
                        event_type="MISSION_REPORT_READY",
                        drone_id=None,
                        details={"summary": "Demo scenario completed. Hash chain intact. Ready for export."},
                        operator_id="SYSTEM"
                    )

                # -------------------------------------------------------------
                # Drone Physics & Telemetry Generation
                # -------------------------------------------------------------
                fleet_telemetry: List[Dict[str, Any]] = []
                drone_states: List[Dict[str, Any]] = []

                for d_id, d_data in self.drones.items():
                    # Angular orbit around sector center
                    angular_speed = 0.08  # rad/s
                    d_data["offset_angle"] += angular_speed / self.tick_rate_hz
                    patrol_radius_lat = 0.003
                    patrol_radius_lon = 0.004

                    nominal_lat = self.sector_center["lat"] + patrol_radius_lat * math.sin(d_data["offset_angle"])
                    nominal_lon = self.sector_center["lon"] + patrol_radius_lon * math.cos(d_data["offset_angle"])

                    lat = nominal_lat
                    lon = nominal_lon
                    fix_type = 3
                    sats = 12
                    eph = 1.0
                    drop_rate = 0.5
                    rssi = 95.0

                    # Apply attacks if active
                    if d_data["spoofed"]:
                        # Sudden 450m position jump and degraded GPS metrics
                        lat += 0.0042
                        lon += 0.0038
                        sats = 4
                        eph = 4.2
                        fix_type = 2

                    if d_data["jammed"]:
                        sats = 3
                        fix_type = 1
                        eph = 6.0
                        drop_rate = 35.0
                        rssi = 25.0

                    d_data["lat"] = lat
                    d_data["lon"] = lon

                    telem = {
                        "drone_id": d_id,
                        "latitude": lat,
                        "longitude": lon,
                        "altitude": d_data["alt"],
                        "ground_speed": d_data["speed"],
                        "heading": math.degrees(d_data["offset_angle"]) % 360,
                        "fix_type": fix_type,
                        "satellites_visible": sats,
                        "eph": eph,
                        "battery_remaining": max(20.0, 100.0 - (self.elapsed_time * 0.1)),
                        "drop_rate_comm": drop_rate,
                        "rssi": rssi,
                        "noise": 15.0,
                        "flight_mode": "GUIDED",
                        "is_armed": True
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

                    state_dict = {
                        **telem,
                        "trust_score": score_breakdown.trust_score,
                        "trust_status": score_breakdown.trust_status,
                        "uncertainty_radius_m": score_breakdown.uncertainty_radius_m,
                        "reason": score_breakdown.reason,
                        # mode="json" turns the timestamp into a string; a raw datetime makes
                        # send_json fail and the WebSocket manager drops every client.
                        "scores": score_breakdown.model_dump(mode="json"),
                        "last_updated": datetime.now(timezone.utc).isoformat()
                    }
                    drone_states.append(state_dict)

                # Broadcast live packet via WebSocket
                ws_payload = {
                    "type": "FLEET_UPDATE",
                    "elapsed_time": self.elapsed_time,
                    "active_sector_interference": trust_evaluator.localized_interference_active,
                    "zones": theatre_rules.zones,
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
