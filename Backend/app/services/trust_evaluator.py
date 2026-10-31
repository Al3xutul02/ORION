import math
import time
from typing import Dict, Any, List, Optional, Tuple
from app.schemas.drone import DroneScoreBreakdown


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates great-circle distance between two points in meters."""
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


class DroneTrustEvaluator:
    """
    Evaluates independent trust metrics (0..100) per drone:
    1. GPS Quality (fix_type, satellites_visible, eph/HDOP)
    2. Inertial Dead-Reckoning Concordance (impossible jumps vs speed, growing uncertainty circle)
    3. Link Health (drop_rate_comm, rssi, noise)
    4. Inter-Drone Neighbor Consensus (relative formation drift)
    5. Localized Sector Interference Detection (when >= 2 drones lose GPS)
    """

    def __init__(self):
        # Drone state cache: drone_id -> {lat, lon, alt, speed, timestamp, uncertainty_radius}
        self.drone_history: Dict[int, Dict[str, Any]] = {}
        self.localized_interference_active: bool = False
        self.affected_drones_in_sector: set[int] = set()

    def evaluate(
        self,
        drone_id: int,
        telemetry: Dict[str, Any],
        peer_telemetries: Optional[List[Dict[str, Any]]] = None,
        command_valid: bool = True
    ) -> DroneScoreBreakdown:
        current_time = time.time()
        lat = telemetry.get("latitude", 0.0)
        lon = telemetry.get("longitude", 0.0)
        alt = telemetry.get("altitude", 0.0)
        speed = telemetry.get("ground_speed", 0.0)
        fix_type = telemetry.get("fix_type", 3)
        sats = telemetry.get("satellites_visible", 12)
        eph = telemetry.get("eph", 1.0)
        drop_rate = telemetry.get("drop_rate_comm", 0.0)
        rssi = telemetry.get("rssi", 100.0)

        # -------------------------------------------------------------
        # 1. GPS Quality Score (0..100)
        # -------------------------------------------------------------
        gps_score = 100.0
        if fix_type < 2:
            gps_score = 0.0
        elif fix_type == 2:
            gps_score = 40.0

        if sats < 4:
            gps_score = min(gps_score, 10.0)
        elif sats < 6:
            gps_score = min(gps_score, 40.0)
        elif sats < 9:
            gps_score = min(gps_score, 75.0)

        if eph > 3.0:
            gps_score = min(gps_score, 30.0)
        elif eph > 2.0:
            gps_score = min(gps_score, 65.0)

        # -------------------------------------------------------------
        # 2. IMU / Dead-Reckoning Concordance & Impossible Jump Check
        # -------------------------------------------------------------
        imu_score = 100.0
        uncertainty_radius = 0.0
        reasons: List[str] = []

        last_state = self.drone_history.get(drone_id)
        if last_state:
            dt = max(0.1, current_time - last_state["timestamp"])
            dist_moved = haversine_distance_m(last_state["lat"], last_state["lon"], lat, lon)
            max_plausible_speed = max(25.0, (speed * 1.8) + 5.0)  # max 25 m/s or 1.8x measured speed
            max_plausible_dist = max_plausible_speed * dt

            if dist_moved > max_plausible_dist:
                # Impossible position jump detected (e.g. GPS spoofing teleportation)
                excess = dist_moved - max_plausible_dist
                imu_score = max(5.0, 100.0 - (excess * 2.5))
                # Dead reckoning uncertainty circle grows
                uncertainty_radius = min(500.0, last_state.get("uncertainty_radius", 0.0) + (excess * 1.2))
                reasons.append(f"Impossible position jump ({dist_moved:.1f}m in {dt:.1f}s)")
            else:
                prev_unc = last_state.get("uncertainty_radius", 0.0)
                # Uncertainty only decays if GPS fix quality is verified clean (3D fix, good satellites & eph)
                if gps_score >= 80.0:
                    uncertainty_radius = max(0.0, prev_unc * 0.85)
                else:
                    uncertainty_radius = prev_unc
                    if uncertainty_radius >= 80.0:
                        imu_score = 10.0
                        reasons.append(f"Position inconsistent with inertial reference (±{uncertainty_radius:.0f}m)")

        # -------------------------------------------------------------
        # 3. Link Health Score (0..100)
        # -------------------------------------------------------------
        link_score = 100.0
        if drop_rate > 20.0:
            link_score -= min(60.0, (drop_rate - 20.0) * 2.0)
        if rssi < 40.0:
            link_score -= (40.0 - rssi) * 1.5
        link_score = max(0.0, min(100.0, link_score))

        # -------------------------------------------------------------
        # 4. Inter-Drone Neighbor Consensus
        # -------------------------------------------------------------
        consensus_score = 100.0
        peers = peer_telemetries or []
        if peers and last_state:
            # Check formation geometry consistency with peers
            # If this drone moved radically while peers moved normally, consensus penalizes this drone
            peer_anomalies = 0
            for peer in peers:
                p_id = peer.get("drone_id")
                if p_id == drone_id:
                    continue
                p_dist = haversine_distance_m(lat, lon, peer.get("latitude", 0), peer.get("longitude", 0))
                # Nominal patrol distance is 100m to 1000m
                if p_dist > 1200.0 and (imu_score < 70.0 or uncertainty_radius >= 80.0 or gps_score < 50.0):
                    peer_anomalies += 1

            if peer_anomalies >= 2:
                consensus_score = 15.0
                reasons.append("Neighbor consensus mismatch (diverged from patrol formation)")

        # -------------------------------------------------------------
        # 5. Localized Sector Interference Evaluation
        # -------------------------------------------------------------
        if gps_score < 40.0:
            self.affected_drones_in_sector.add(drone_id)
        else:
            self.affected_drones_in_sector.discard(drone_id)

        if len(self.affected_drones_in_sector) >= 2:
            self.localized_interference_active = True
        elif len(self.affected_drones_in_sector) == 0:
            self.localized_interference_active = False

        # -------------------------------------------------------------
        # 6. Command Validity Score
        # -------------------------------------------------------------
        cmd_score = 100.0 if command_valid else 0.0
        if not command_valid:
            reasons.append("Unauthenticated or replayed command")

        # -------------------------------------------------------------
        # Aggregate Trust Score Calculation
        # -------------------------------------------------------------
        trust_score = (
            (0.30 * gps_score) +
            (0.30 * imu_score) +
            (0.20 * link_score) +
            (0.20 * consensus_score)
        )
        if not command_valid:
            trust_score = min(trust_score, 30.0)

        # Critical security override: if an impossible jump is detected or IMU concordance fails catastrophically,
        # the drone cannot be trusted (immediately drop to RED < 40)
        if imu_score <= 20.0 or uncertainty_radius >= 100.0:
            trust_score = min(trust_score, 35.0)

        trust_score = round(max(0.0, min(100.0, trust_score)), 1)

        # Status determination
        if trust_score >= 75.0:
            status = "GREEN"
        elif trust_score >= 40.0:
            status = "YELLOW"
        else:
            status = "RED"

        if not reasons:
            reasons.append("Sensors & consensus nominal")

        # Update cache
        self.drone_history[drone_id] = {
            "lat": lat,
            "lon": lon,
            "alt": alt,
            "speed": speed,
            "timestamp": current_time,
            "uncertainty_radius": uncertainty_radius
        }

        from datetime import datetime, timezone
        return DroneScoreBreakdown(
            drone_id=drone_id,
            trust_score=trust_score,
            trust_status=status,
            gps_score=round(gps_score, 1),
            imu_score=round(imu_score, 1),
            link_score=round(link_score, 1),
            consensus_score=round(consensus_score, 1),
            command_score=round(cmd_score, 1),
            uncertainty_radius_m=round(uncertainty_radius, 1),
            reason="; ".join(reasons),
            timestamp=datetime.now(timezone.utc)
        )


trust_evaluator = DroneTrustEvaluator()
