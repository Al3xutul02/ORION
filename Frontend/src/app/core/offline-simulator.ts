import { evaluateActions, egressPaths, distanceM } from './geo';
import { HashChainLedger } from './hash-chain';
import { DroneState, FleetUpdate, Recommendation, TrustStatus, Zone } from './models';

/**
 * Plan B from the spec: the same fixed 3-minute timeline as Backend/app/services/simulator.py,
 * run entirely in the browser so the demo works when the backend or MySQL is down.
 */

const CENTER = { lat: 44.335, lon: 23.83 };
const ORBIT = { lat: 0.003, lon: 0.004 };
const ANGULAR_SPEED = 0.08; // rad/s
const SPOOF_OFFSET = { lat: 0.0042, lon: 0.0038 };
const EGRESS_SPEED_MS = 22;

const INITIAL_ZONES: Zone[] = [
  { id: 1, name: 'Base Forward Alpha', zone_type: 'BASE', geometry_type: 'CIRCLE', center: [44.316, 23.8], radius_m: 350, is_active: true, detected_by: 'PRECONFIGURED' },
  {
    id: 2, name: 'Safe Corridor Alpha', zone_type: 'SAFE_CORRIDOR', geometry_type: 'POLYGON',
    waypoints: [[44.316, 23.8], [44.322, 23.805], [44.33, 23.81], [44.338, 23.815]],
    is_active: true, detected_by: 'PRECONFIGURED',
  },
  { id: 3, name: 'EW Jamming Zone Sector 4', zone_type: 'INTERFERENCE', geometry_type: 'CIRCLE', center: [44.328, 23.82], radius_m: 600, is_active: true, detected_by: 'PRECONFIGURED' },
  { id: 4, name: 'Restricted Threat Zone Bravo', zone_type: 'THREAT', geometry_type: 'CIRCLE', center: [44.34, 23.84], radius_m: 500, is_active: true, detected_by: 'PRECONFIGURED' },
];

interface SimDrone {
  id: number;
  angle: number;
  lat: number;
  lon: number;
  spoofedAt: number | null;
  jammedAt: number | null;
  mode: 'PATROL' | 'LOITER' | 'EGRESS' | 'LANDED';
  loiterUntil: number;
  egressPath: [number, number][]; // [lon, lat]
  egressLeg: number;
}

export interface OfflineCallbacks {
  onFleet(update: FleetUpdate): void;
  onLedger(): void;
  onRecommendations(recs: Recommendation[]): void;
}

export class OfflineSimulator {
  readonly ledger = new HashChainLedger();
  elapsed = 0;
  running = false;
  speed = 1;

  private drones: SimDrone[] = [];
  private zones: Zone[] = [];
  private recs: Recommendation[] = [];
  private milestones = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private commandSeq = 6;

  constructor(private cb: OfflineCallbacks) {
    this.reset();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), 500);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset(): void {
    this.stop();
    this.elapsed = 0;
    this.milestones.clear();
    this.recs = [];
    this.zones = structuredClone(INITIAL_ZONES);
    this.drones = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((angle, i) => ({
      id: i + 1, angle, lat: 0, lon: 0, spoofedAt: null, jammedAt: null,
      mode: 'PATROL', loiterUntil: 0, egressPath: [], egressLeg: 0,
    }));
    for (const d of this.drones) this.move(d, 0); // place on the patrol orbit before the first tick
    this.ledger.reset();
    this.log('SYSTEM_INITIALIZED', null, { system: 'ORION Ground Control Station', mode: 'OFFLINE_PLAN_B' });
    this.cb.onRecommendations([]);
    this.emit();
  }

  dispose(): void {
    this.stop();
  }

  // ---- scenario triggers (also used by the manual buttons) -------------------------------

  triggerSpoofing(): void {
    if (this.milestones.has('spoof')) return;
    this.milestones.add('spoof');
    this.drone(2).spoofedAt = this.elapsed;
    this.log('SPOOFING_ATTACK_INITIATED', 2, {
      attack_vector: 'GPS_SPOOFING_INJECTION', target: 'Drone 2',
      description: 'False ephemeris and sudden position jump injected',
    }, 'SIMULATOR');
  }

  issueRecommendation(): void {
    if (this.milestones.has('rec')) return;
    this.milestones.add('rec');
    const state = this.states().find(d => d.drone_id === 2)!;
    const actions = evaluateActions(state, this.zones);
    const rtl = actions.find(a => a.id === 'RETURN_TO_HOME')!;
    const rec: Recommendation = {
      id: this.recs.length + 1,
      drone_id: 2,
      timestamp: new Date().toISOString(),
      trigger_event: rtl.allowed ? 'TRUST_DEGRADED' : 'TRUST_DEGRADED_EW_HAZARD',
      blocked_action: rtl.allowed ? 'NONE' : 'RETURN_TO_HOME',
      blocked_reason: rtl.allowed ? 'Direct corridor clear' : `Direct Return-to-Home route blocked: ${rtl.reason}`,
      recommended_action: rtl.allowed ? 'RETURN_TO_HOME' : 'LOITER_THEN_SAFE_CORRIDOR_RETREAT',
      recommendation_details: rtl.allowed
        ? 'Corridor to Home Base is clear of known EW interference. Standard RTL permitted.'
        : '1. Command immediate LOITER to stabilize. 2. Steer egress via Safe Corridor Alpha (avoiding EW Jamming Zone Sector 4) to Base.',
      status: 'PENDING',
      operator_id: null,
      approved_at: null,
    };
    this.recs = [rec, ...this.recs];
    this.log('RECOMMENDATION_ISSUED', 2, {
      recommendation_id: rec.id, blocked_action: rec.blocked_action,
      blocked_reason: rec.blocked_reason, recommended_action: rec.recommended_action,
    }, 'ORION_THEATRE_RULES');
    this.cb.onRecommendations(this.recs);
  }

  triggerReplay(): void {
    if (this.milestones.has('replay')) return;
    this.milestones.add('replay');
    this.log('COMMAND_REPLAY_REJECTED', 2, {
      command: 'RETURN_TO_HOME', sequence: 5, age_s: 30,
      reason: 'Replay detected: sequence already consumed and timestamp expired',
      signature: 'fabricated_or_replayed_signature_deadbeef1234',
    }, 'SIMULATED_ADVERSARY');
  }

  triggerInterference(): void {
    if (this.milestones.has('interference')) return;
    this.milestones.add('interference');
    this.drone(1).jammedAt = this.elapsed;
    this.drone(3).jammedAt = this.elapsed;
    this.zones = [...this.zones, {
      id: this.zones.length + 1, name: 'Localized EW Interference (Sector 4)', zone_type: 'INTERFERENCE',
      geometry_type: 'CIRCLE', center: [CENTER.lat, CENTER.lon], radius_m: 650, is_active: true,
      detected_by: 'ORION_CONSENSUS',
    }];
    this.log('ZONE_INTERFERENCE_MARKED', null, {
      sector: 'Sector 4', affected_drones: [1, 3], reallocated_to: [4],
      action: 'Dynamic EW zone mapped; patrol reallocated outside',
    }, 'ORION_CONSENSUS');
  }

  markReportReady(): void {
    if (this.milestones.has('report')) return;
    this.milestones.add('report');
    this.log('MISSION_REPORT_READY', null, { summary: 'Demo scenario completed. Hash chain intact. Ready for export.' });
  }

  decide(recId: number, decision: 'APPROVE' | 'REJECT', operatorId: string): { ok: boolean; message: string } {
    const rec = this.recs.find(r => r.id === recId);
    if (!rec || rec.status !== 'PENDING') return { ok: false, message: 'Recommendation is no longer pending.' };
    const now = new Date().toISOString();
    rec.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    rec.operator_id = operatorId;
    rec.approved_at = now;
    this.recs = [...this.recs];
    this.cb.onRecommendations(this.recs);

    if (decision === 'REJECT') {
      this.log('OPERATOR_REJECTION', rec.drone_id, { recommendation_id: rec.id }, operatorId);
      return { ok: true, message: 'Recommendation rejected.' };
    }

    const seq = this.commandSeq++;
    this.log('OPERATOR_APPROVAL', rec.drone_id, { recommendation_id: rec.id, action: rec.recommended_action }, operatorId);
    this.log('COMMAND_EXECUTED', rec.drone_id, {
      command: rec.recommended_action, sequence: seq, signed: true, signing: 'MAVLINK2_HMAC_SHA256',
    }, operatorId);

    const d = this.drone(rec.drone_id);
    const state = this.states().find(s => s.drone_id === rec.drone_id)!;
    if (rec.recommended_action === 'RETURN_TO_HOME') {
      d.egressPath = egressPaths(state, this.zones).direct;
      d.mode = 'EGRESS';
    } else {
      d.mode = 'LOITER';
      d.loiterUntil = this.elapsed + 8;
      d.egressPath = egressPaths(state, this.zones).viaCorridor;
    }
    d.egressLeg = 0;
    this.emit();
    return { ok: true, message: `Signed ${rec.recommended_action} dispatched (seq ${seq}).` };
  }

  // ---- simulation loop -------------------------------------------------------------------

  private tick(): void {
    const now = performance.now();
    const dt = ((now - this.lastTick) / 1000) * this.speed;
    this.lastTick = now;
    this.elapsed = Math.round((this.elapsed + dt) * 10) / 10;

    if (this.elapsed >= 30) this.triggerSpoofing();
    if (this.elapsed >= 60) this.issueRecommendation();
    if (this.elapsed >= 100) this.triggerReplay();
    if (this.elapsed >= 130) this.triggerInterference();
    if (this.elapsed >= 160) this.markReportReady();

    for (const d of this.drones) this.move(d, dt);
    this.emit();
  }

  private move(d: SimDrone, dt: number): void {
    if (d.mode === 'PATROL') {
      d.angle += ANGULAR_SPEED * dt;
      d.lat = CENTER.lat + ORBIT.lat * Math.sin(d.angle);
      d.lon = CENTER.lon + ORBIT.lon * Math.cos(d.angle);
      return;
    }
    if (d.mode === 'LOITER') {
      if (d.egressPath.length && this.elapsed >= d.loiterUntil) d.mode = 'EGRESS';
      return;
    }
    if (d.mode === 'EGRESS') {
      let budget = EGRESS_SPEED_MS * dt;
      // Positions here are the drone's own (spoofed) frame; strip the offset while moving.
      const off = d.spoofedAt !== null ? SPOOF_OFFSET : { lat: 0, lon: 0 };
      while (budget > 0 && d.egressLeg < d.egressPath.length - 1) {
        const [tLon, tLat] = d.egressPath[d.egressLeg + 1];
        const curLat = d.lat + off.lat, curLon = d.lon + off.lon;
        const dist = distanceM(curLat, curLon, tLat, tLon);
        if (dist <= budget) {
          d.lat = tLat - off.lat; d.lon = tLon - off.lon;
          d.egressLeg++; budget -= dist;
        } else {
          const f = budget / dist;
          d.lat += (tLat - curLat) * f; d.lon += (tLon - curLon) * f;
          budget = 0;
        }
      }
      if (d.egressLeg >= d.egressPath.length - 1) {
        d.mode = 'LANDED';
        this.log('DRONE_RECOVERED', d.id, { location: 'Base Forward Alpha', via: 'Safe Corridor Alpha' });
      }
    }
  }

  private states(): DroneState[] {
    const ts = new Date().toISOString();
    return this.drones.map(d => {
      const spoofed = d.spoofedAt !== null;
      const jammed = d.jammedAt !== null;
      let lat = d.lat, lon = d.lon;
      let fix = 3, sats = 12, eph = 1.0, drop = 0.5, rssi = 95;
      if (spoofed) { lat += SPOOF_OFFSET.lat; lon += SPOOF_OFFSET.lon; sats = 4; eph = 4.2; fix = 2; }
      if (jammed) { sats = 3; fix = 1; eph = 6.0; drop = 35; rssi = 25; }

      let gps = fix < 2 ? 0 : fix === 2 ? 40 : 100;
      if (sats < 4) gps = Math.min(gps, 10); else if (sats < 6) gps = Math.min(gps, 40); else if (sats < 9) gps = Math.min(gps, 75);
      if (eph > 3) gps = Math.min(gps, 30); else if (eph > 2) gps = Math.min(gps, 65);

      const reasons: string[] = [];
      let imu = 100, unc = 0, consensus = 100;
      if (spoofed) {
        const t = this.elapsed - d.spoofedAt!;
        imu = 10;
        unc = Math.min(450, 60 + t * 6);
        consensus = 15;
        reasons.push('Impossible position jump (≈560 m in 0.5 s)', 'Neighbor consensus mismatch (diverged from patrol formation)');
      }
      if (jammed) {
        const t = this.elapsed - d.jammedAt!;
        imu = Math.min(imu, 70);
        unc = Math.max(unc, Math.min(260, 30 + t * 4));
        consensus = Math.min(consensus, 60);
        reasons.push('GPS lost, dead reckoning active', 'Peers in same sector degraded: localized interference');
      }
      if (sats < 6 && !spoofed && !jammed) reasons.push('Low satellite count');
      const link = Math.max(0, Math.min(100, rssi, 100 - drop * 2));
      if (link < 60) reasons.push('Command link degraded');

      let score = 0.3 * gps + 0.3 * imu + 0.2 * link + 0.2 * consensus;
      if (imu <= 20 || unc >= 100) score = Math.min(score, 35);
      score = Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
      const status: TrustStatus = score >= 75 ? 'GREEN' : score >= 40 ? 'YELLOW' : 'RED';
      const reason = reasons.length ? reasons.join('; ') : 'Sensors & consensus nominal';

      const flightMode = d.mode === 'PATROL' ? 'GUIDED' : d.mode === 'EGRESS' ? 'GUIDED·EGRESS' : d.mode;
      return {
        drone_id: d.id, latitude: lat, longitude: lon, altitude: d.mode === 'LANDED' ? 0 : 120,
        ground_speed: d.mode === 'PATROL' ? 12 : d.mode === 'EGRESS' ? EGRESS_SPEED_MS : 0,
        heading: ((d.angle * 180) / Math.PI + 90) % 360,
        fix_type: fix, satellites_visible: sats, eph,
        battery_remaining: Math.max(20, 100 - this.elapsed * 0.1),
        drop_rate_comm: drop, rssi, flight_mode: flightMode, is_armed: d.mode !== 'LANDED',
        trust_score: score, trust_status: status, uncertainty_radius_m: unc, reason,
        scores: {
          drone_id: d.id, trust_score: score, trust_status: status, gps_score: gps, imu_score: imu,
          link_score: link, consensus_score: consensus, command_score: 100, uncertainty_radius_m: unc, reason,
        },
        last_updated: ts,
      };
    });
  }

  private emit(): void {
    const drones = this.states();
    this.cb.onFleet({
      type: 'FLEET_UPDATE',
      elapsed_time: this.elapsed,
      active_sector_interference: this.milestones.has('interference'),
      zones: this.zones,
      drones,
    });
  }

  private log(type: string, droneId: number | null, details: Record<string, unknown>, operator = 'SYSTEM'): void {
    this.ledger.append(type, droneId, details, operator).then(() => this.cb.onLedger());
  }

  private drone(id: number): SimDrone {
    return this.drones.find(d => d.id === id)!;
  }
}
