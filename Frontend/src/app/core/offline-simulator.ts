import { ActionOption, evaluateActions, egressPaths, distanceM, hazardZones, segmentIntersectsCircle, weatherAt } from './geo';
import { WEATHER_TEMPLATES, describeWeather, isSevereWeather, isWeather, weatherEffects } from './platform';
import { HashChainLedger } from './hash-chain';
import { DroneState, FleetUpdate, Recommendation, TrustStatus, WeatherKind, Zone } from './models';

/**
 * Plan B from the spec, extended into a fuller (simulated, defensive) conflict exercise over
 * the Craiova area: the backend's fixed 3-minute timeline, plus a mobile hostile jammer that
 * ORION tracks by peer consensus and a command-link loss handled by the zone-aware failsafe.
 * Runs entirely in the browser so the demo works when the backend or MySQL is down.
 */

interface Sector {
  name: string;
  center: { lat: number; lon: number };
  orbit: { lat: number; lon: number };
}

const SECTORS: Record<'A' | 'B', Sector> = {
  A: { name: 'Sector 4', center: { lat: 44.335, lon: 23.83 }, orbit: { lat: 0.003, lon: 0.004 } },
  B: { name: 'Sector 7', center: { lat: 44.348, lon: 23.855 }, orbit: { lat: 0.0022, lon: 0.003 } },
};
const ANGULAR_SPEED = 0.08; // rad/s
const SPOOF_OFFSET = { lat: 0.0042, lon: 0.0038 };
const EGRESS_SPEED_MS = 22;

// Hostile mobile EW emitter: enters from the south-east, crosses Sector 4, withdraws into Bravo.
const JAMMER = {
  path: [[44.329, 23.842], [44.335, 23.83], [44.341, 23.848]] as [number, number][],
  speedMs: 45,
  radiusM: 430,
};

const LINK_LOSS = { droneId: 5, durationS: 15, failsafeAfterS: 5 };

const SCRIPT = { spoof: 30, recommend: 60, replay: 100, jammer: 112, linkLoss: 145, report: 160 };

const DYNAMIC_ZONE_ID = 100;

// Where each weather kind enters the Demo theatre and how it drifts (m/s north, m/s east),
// chosen so the storm crosses Sector 7 and the rain sits over the base and corridor.
const WEATHER_ENTRY: Record<WeatherKind, { center: [number, number]; driftMs: [number, number] }> = {
  STORM: { center: [44.351, 23.866], driftMs: [-1.5, -8] },
  RAIN: { center: [44.324, 23.806], driftMs: [0.4, 2.5] },
  WIND: { center: [44.338, 23.848], driftMs: [3, 0.5] },
};
const WEATHER_BOUNDS = { lat: [44.3, 44.365], lon: [23.775, 23.875] };
const M_PER_DEG_LAT = 111139;

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
  sector: Sector;
  angle: number;
  lat: number; // true position (the spoof offset is applied only to what the drone reports)
  lon: number;
  spoofedAt: number | null;
  jammedAt: number | null;
  linkLostAt: number | null;
  failsafeDone: boolean;
  safeAirspaceTime: number;
  mode: 'PATROL' | 'LOITER' | 'EGRESS' | 'LANDED';
  loiterUntil: number;
  egressPath: [number, number][]; // [lon, lat]
  egressLeg: number;
  route: 'RTL' | 'CORRIDOR' | 'ROUTE';
  batteryUsed: number; // % drained; weather makes it drain faster
  weatherAlert: number | null; // id of the over-limit weather zone already reported
}

interface Jammer {
  lat: number;
  lon: number;
  leg: number;
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
  private jammer: Jammer | null = null;
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
    this.jammer = null;
    this.zones = structuredClone(INITIAL_ZONES);
    const fleet: [Sector, number][] = [
      [SECTORS.A, 0], [SECTORS.A, Math.PI / 2], [SECTORS.A, Math.PI], [SECTORS.A, (3 * Math.PI) / 2],
      [SECTORS.B, Math.PI / 4], [SECTORS.B, (5 * Math.PI) / 4],
    ];
    this.drones = fleet.map(([sector, angle], i) => ({
      id: i + 1, sector, angle, lat: 0, lon: 0, spoofedAt: null, jammedAt: null, linkLostAt: null, failsafeDone: false,
      safeAirspaceTime: 0, mode: 'PATROL', loiterUntil: 0, egressPath: [], egressLeg: 0, route: 'CORRIDOR',
      batteryUsed: 0, weatherAlert: null,
    }));
    for (const d of this.drones) this.move(d, 0); // place on the patrol orbit before the first tick
    this.ledger.reset();
    this.log('SYSTEM_INITIALIZED', null, {
      system: 'ORION Ground Control Station', mode: 'DEMO_MODE',
      exercise: 'Simulated defensive exercise, Craiova area', drones: this.drones.length,
    });
    this.cb.onRecommendations([]);
    this.emit();
  }

  dispose(): void {
    this.stop();
  }

  /** Advances the simulation by dt seconds of mission time (the timer calls this; tests too). */
  advance(dt: number): void {
    this.elapsed = Math.round((this.elapsed + dt) * 10) / 10;

    if (this.elapsed >= SCRIPT.spoof) this.triggerSpoofing();
    if (this.elapsed >= SCRIPT.recommend) this.issueRecommendation();
    if (this.elapsed >= SCRIPT.replay) this.triggerReplay();
    if (this.elapsed >= SCRIPT.jammer) this.triggerInterference();
    if (this.elapsed >= SCRIPT.linkLoss) this.triggerLinkLoss();
    if (this.elapsed >= SCRIPT.report) this.markReportReady();

    this.moveJammer(dt);
    this.driftWeather(dt);
    for (const d of this.drones) {
      this.move(d, dt);
      this.updateRecalibration(d, dt);
      this.updateWeather(d, dt);
    }
    this.updateJamming();
    this.updateLinks();
    this.emit();
  }

  // ---- weather -----------------------------------------------------------------------------

  private nextWeatherId = 200;

  /** Brings a weather cell into the theatre (only from the buttons; the scripted timeline has none). */
  triggerWeather(kind: WeatherKind): void {
    const active = this.zones.filter(z => z.is_active && isWeather(z));
    if (active.length >= 2) active[0].is_active = false;
    const tpl = WEATHER_TEMPLATES[kind];
    const { center, driftMs } = WEATHER_ENTRY[kind];
    const zone: Zone = {
      id: this.nextWeatherId++, ...tpl, zone_type: 'WEATHER', geometry_type: 'CIRCLE', center: [...center],
      is_active: true, detected_by: 'MET_SERVICE', weather: kind,
      drift: [driftMs[0] / M_PER_DEG_LAT, driftMs[1] / (M_PER_DEG_LAT * Math.cos((center[0] * Math.PI) / 180))],
    };
    this.zones = [...this.zones, zone];
    this.log('WEATHER_CELL_DETECTED', null, {
      zone: zone.name, description: `${zone.name} entering the theatre: ${describeWeather(zone)}`, blocks_flight: isSevereWeather(zone),
    }, 'MET_SERVICE');
  }

  clearWeather(): void {
    const zone = this.zones.find(z => z.is_active && isWeather(z));
    if (!zone) return;
    zone.is_active = false;
    this.zones = [...this.zones];
    this.log('WEATHER_CLEARED', null, { zone: zone.name, description: `${zone.name} has dissipated` }, 'MET_SERVICE');
  }

  private driftWeather(dt: number): void {
    let moved = false;
    for (const z of this.zones) {
      if (!z.is_active || !isWeather(z) || !z.drift) continue;
      z.center = [z.center![0] + z.drift[0] * dt, z.center![1] + z.drift[1] * dt];
      moved = true;
      const [lat, lon] = z.center;
      if (lat < WEATHER_BOUNDS.lat[0] || lat > WEATHER_BOUNDS.lat[1] || lon < WEATHER_BOUNDS.lon[0] || lon > WEATHER_BOUNDS.lon[1]) {
        z.is_active = false;
        this.log('WEATHER_CLEARED', null, { zone: z.name, description: `${z.name} drifted out of the theatre` }, 'MET_SERVICE');
      }
    }
    if (moved) this.zones = [...this.zones];
  }

  /** Battery drain under wind, and the alert + recommendation when a drone is caught beyond limits. */
  private updateWeather(d: SimDrone, dt: number): void {
    const off = d.spoofedAt !== null ? SPOOF_OFFSET : { lat: 0, lon: 0 };
    const wx = weatherAt(this.zones, d.lat + off.lat, d.lon + off.lon);
    if (d.mode !== 'LANDED') d.batteryUsed += 0.1 * dt * weatherEffects(wx).batteryMult;
    if (!wx || !isSevereWeather(wx)) {
      d.weatherAlert = null;
      return;
    }
    if (d.weatherAlert === wx.id || (d.mode !== 'PATROL' && d.mode !== 'LOITER')) return;
    d.weatherAlert = wx.id;
    this.log('WEATHER_LIMIT_EXCEEDED', d.id, { zone: wx.name, reason: `${wx.name}: ${describeWeather(wx)}. Leave the cell` }, 'ORION_THEATRE_RULES');
    this.recommendFor(d.id, 'WEATHER_LIMIT_EXCEEDED');
  }

  /** A recommendation built from the current action matrix (used for weather; the scripted D2 one stays as is). */
  private recommendFor(droneId: number, trigger: string): void {
    if (this.recs.some(r => r.drone_id === droneId && r.status === 'PENDING')) return;
    const state = this.states().find(s => s.drone_id === droneId)!;
    const actions = evaluateActions(state, this.zones);
    const rtl = actions.find(a => a.id === 'RETURN_TO_HOME')!;
    const pick = actions.find(a => a.recommended && a.id !== 'LOITER') ?? actions.find(a => a.id === 'LOITER')!;
    const rec: Recommendation = {
      id: this.recs.length + 1,
      drone_id: droneId,
      timestamp: new Date().toISOString(),
      trigger_event: trigger,
      blocked_action: rtl.allowed ? 'NONE' : 'RETURN_TO_HOME',
      blocked_reason: rtl.allowed ? 'Direct path to base is clear' : `Direct Return-to-Home route blocked: ${rtl.reason}`,
      recommended_action: pick.id,
      recommendation_details: `${pick.label}: ${pick.reason}`,
      status: 'PENDING',
      operator_id: null,
      approved_at: null,
    };
    this.recs = [rec, ...this.recs];
    this.log('RECOMMENDATION_ISSUED', droneId, {
      recommendation_id: rec.id, blocked_action: rec.blocked_action,
      blocked_reason: rec.blocked_reason, recommended_action: rec.recommended_action,
    }, 'ORION_THEATRE_RULES');
    this.cb.onRecommendations(this.recs);
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

  /** A hostile mobile jammer enters the theatre; ORION only sees its effect on the drones. */
  triggerInterference(): void {
    if (this.milestones.has('jammer')) return;
    this.milestones.add('jammer');
    const [lat, lon] = JAMMER.path[0];
    this.jammer = { lat, lon, leg: 0 };
    this.log('EW_EMITTER_ACTIVE', null, {
      description: 'Simulated hostile mobile jammer starts transmitting south-east of Sector 4',
    }, 'SIMULATOR');
  }

  triggerLinkLoss(): void {
    if (this.milestones.has('linkloss')) return;
    const d = this.drone(LINK_LOSS.droneId);
    if (d.mode === 'LANDED') return;
    this.milestones.add('linkloss');
    d.linkLostAt = this.elapsed;
    d.failsafeDone = false;
    this.log('COMMAND_LINK_LOST', d.id, {
      description: 'Command link jammed: no telemetry acknowledgements',
      failsafe_in_s: LINK_LOSS.failsafeAfterS,
    }, 'SIMULATOR');
  }

  markReportReady(): void {
    if (this.milestones.has('report')) return;
    this.milestones.add('report');
    this.log('MISSION_REPORT_READY', null, { summary: 'Exercise completed. Hash chain intact. Ready for export.' });
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

    this.log('OPERATOR_APPROVAL', rec.drone_id, { recommendation_id: rec.id, action: rec.recommended_action }, operatorId);
    const seq = this.dispatch(rec.drone_id, rec.recommended_action, operatorId);
    return { ok: true, message: `Signed ${rec.recommended_action} dispatched (seq ${seq}).` };
  }

  /** Operator-chosen command for one drone (the store has already checked it is allowed). */
  command(droneId: number, action: ActionOption['id'], operatorId: string): { ok: boolean; message: string } {
    const d = this.drone(droneId);
    if (!d || d.mode === 'LANDED') return { ok: false, message: `Drone ${droneId} has landed.` };
    if (this.linkDown(d)) {
      this.log('COMMAND_UNDELIVERABLE', droneId, { action, reason: 'Command link lost' }, operatorId);
      return { ok: false, message: `Drone ${droneId} is out of contact; the onboard failsafe is in control.` };
    }
    this.log('OPERATOR_COMMAND', droneId, { action, origin: 'MANUAL' }, operatorId);
    // A manual order supersedes whatever ORION was still waiting on for this drone.
    for (const rec of this.recs.filter(r => r.drone_id === droneId && r.status === 'PENDING')) {
      rec.status = 'SUPERSEDED';
      rec.operator_id = operatorId;
      rec.approved_at = new Date().toISOString();
      this.log('RECOMMENDATION_SUPERSEDED', droneId, { recommendation_id: rec.id, reason: `Operator chose ${action} instead` }, operatorId);
    }
    this.recs = [...this.recs];
    this.cb.onRecommendations(this.recs);
    const seq = this.dispatch(droneId, action, operatorId);
    return { ok: true, message: `Signed ${action} sent to Drone ${droneId} (seq ${seq}).` };
  }

  private dispatch(droneId: number, action: string, operatorId: string): number {
    const seq = this.commandSeq++;
    this.log('COMMAND_EXECUTED', droneId, {
      command: action, sequence: seq, signed: true, signing: 'MAVLINK2_HMAC_SHA256',
    }, operatorId);

    const d = this.drone(droneId);
    const state = this.states().find(s => s.drone_id === droneId)!;
    const paths = egressPaths(state, this.zones);
    d.egressLeg = 0;
    switch (action) {
      case 'RETURN_TO_HOME':
        d.route = 'RTL';
        d.egressPath = paths.direct;
        d.mode = 'EGRESS';
        break;
      case 'SAFE_CORRIDOR_RETREAT':
        d.route = 'CORRIDOR';
        d.egressPath = paths.viaCorridor;
        d.mode = 'EGRESS';
        break;
      case 'SAFE_ROUTE_RETREAT':
        if (paths.viaRoute.length) {
          d.route = 'ROUTE';
          d.egressPath = paths.viaRoute;
          d.mode = 'EGRESS';
        } else {
          d.mode = 'LOITER';
          d.loiterUntil = Infinity;
          d.egressPath = [];
        }
        break;
      case 'LOITER':
        d.mode = 'LOITER';
        d.loiterUntil = Infinity;
        d.egressPath = [];
        break;
      case 'LOITER_THEN_SAFE_CORRIDOR_RETREAT':
        d.route = 'CORRIDOR';
        d.mode = 'LOITER';
        d.loiterUntil = this.elapsed + 8;
        d.egressPath = paths.viaCorridor;
        break;
      case 'CONTINUE_PATROL': {
        // Rejoin the orbit at the nearest point instead of jumping back to the old one.
        const { center, orbit } = d.sector;
        d.angle = Math.atan2((d.lat - center.lat) / orbit.lat, (d.lon - center.lon) / orbit.lon);
        d.mode = 'PATROL';
        d.egressPath = [];
        break;
      }
    }
    this.emit();
    return seq;
  }

  // ---- simulation loop -------------------------------------------------------------------

  private tick(): void {
    const now = performance.now();
    // Browsers throttle timers in background tabs; cap the step so the exercise pauses
    // there instead of leaping a minute ahead when the tab comes back.
    const dt = Math.min((now - this.lastTick) / 1000, 1) * this.speed;
    this.lastTick = now;
    this.advance(dt);
  }

  private moveJammer(dt: number): void {
    const j = this.jammer;
    if (!j) return;
    let budget = JAMMER.speedMs * dt;
    while (budget > 0 && j.leg < JAMMER.path.length - 1) {
      const [tLat, tLon] = JAMMER.path[j.leg + 1];
      const dist = distanceM(j.lat, j.lon, tLat, tLon);
      if (dist <= budget) {
        j.lat = tLat; j.lon = tLon; j.leg++; budget -= dist;
      } else {
        const f = budget / dist;
        j.lat += (tLat - j.lat) * f; j.lon += (tLon - j.lon) * f;
        budget = 0;
      }
    }
  }

  /**
   * When a spoofed/jammed drone retreats via a safe corridor or loiters in clean airspace
   * outside all active hazard zones for ~4 seconds, its onboard EKF/IMU recalibrates.
   */
  private updateRecalibration(d: SimDrone, dt: number): void {
    if (d.mode === 'LANDED' || d.mode === 'PATROL') {
      d.safeAirspaceTime = 0;
      return;
    }
    if (d.spoofedAt === null && d.jammedAt === null) {
      d.safeAirspaceTime = 0;
      return;
    }

    // Hazards act on the real airframe (d.lat/d.lon), not on the spoofed fix it reports.
    const insideZone = this.zones.some(
      z =>
        z.is_active &&
        (z.zone_type === 'INTERFERENCE' || z.zone_type === 'THREAT') &&
        z.geometry_type === 'CIRCLE' &&
        z.center &&
        z.radius_m &&
        distanceM(d.lat, d.lon, z.center[0], z.center[1]) <= z.radius_m
    );
    const inJammer = !!this.jammer && distanceM(d.lat, d.lon, this.jammer.lat, this.jammer.lon) <= JAMMER.radiusM;

    if (insideZone || inJammer) {
      d.safeAirspaceTime = 0;
      return;
    }

    d.safeAirspaceTime += dt;
    if (d.safeAirspaceTime >= 4.0) {
      const wasSpoofed = d.spoofedAt !== null;
      d.spoofedAt = null;
      d.jammedAt = null;
      d.safeAirspaceTime = 0;
      if (wasSpoofed && d.egressPath.length > 0 && (d.mode === 'LOITER' || d.mode === 'EGRESS')) {
        // Recompute egress route from the restored true physical position
        const state = this.states().find(s => s.drone_id === d.id)!;
        const paths = egressPaths(state, this.zones);
        d.egressPath = d.route === 'RTL' ? paths.direct : d.route === 'ROUTE' ? paths.viaRoute : paths.viaCorridor;
        d.egressLeg = 0;
      }
      this.log('GPS_RESTORED', d.id, {
        description: `Drone ${d.id} recalibrated onboard EKF/IMU in safe airspace (${d.mode}) and restored true 3D GPS position`,
      });
      if (d.mode === 'LOITER' || d.mode === 'EGRESS') {
        const resumeRec: Recommendation = {
          id: this.recs.length + 1,
          drone_id: d.id,
          timestamp: new Date().toISOString(),
          trigger_event: 'SENSORS_RECALIBRATED_SAFE',
          blocked_action: 'NONE',
          blocked_reason: 'Sensors and navigation nominal',
          recommended_action: 'CONTINUE_PATROL',
          recommendation_details: 'Sensors recalibrated and clean GPS fix verified. Airspace is clear; safe to resume regular sector patrol.',
          status: 'PENDING',
          operator_id: null,
          approved_at: null,
        };
        this.recs = [resumeRec, ...this.recs];
        this.log('RECOMMENDATION_ISSUED', d.id, {
          recommendation_id: resumeRec.id,
          blocked_action: resumeRec.blocked_action,
          blocked_reason: resumeRec.blocked_reason,
          recommended_action: resumeRec.recommended_action,
        }, 'ORION_THEATRE_RULES');
        this.cb.onRecommendations(this.recs);
      }
    }
  }

  /**
   * Drones inside the emitter's range lose GPS. ORION never sees the emitter itself: one
   * degraded drone is treated as a local fault; two or more at once means a zone, which is
   * mapped around the affected drones and tracked as they change.
   */
  private updateJamming(): void {
    const j = this.jammer;
    const affected: SimDrone[] = [];
    for (const d of this.drones) {
      const inRange = !!j && d.mode !== 'LANDED' && distanceM(d.lat, d.lon, j.lat, j.lon) <= JAMMER.radiusM;
      if (inRange && d.jammedAt === null) d.jammedAt = this.elapsed;
      if (!inRange && d.jammedAt !== null) {
        d.jammedAt = null;
        this.log('GPS_RESTORED', d.id, { description: 'Satellite fix reacquired' });
      }
      if (inRange) affected.push(d);
    }

    if (affected.length === 1 && !this.milestones.has('single-fault')) {
      this.milestones.add('single-fault');
      this.log('GPS_DEGRADED_SINGLE', affected[0].id, {
        assessment: 'Peers nominal: treated as a drone-level fault, no zone marked yet',
      }, 'ORION_CONSENSUS');
    }

    if (affected.length < 2) return;
    const repPos = (d: SimDrone) => ({
      lat: d.lat + (d.spoofedAt !== null ? SPOOF_OFFSET.lat : 0),
      lon: d.lon + (d.spoofedAt !== null ? SPOOF_OFFSET.lon : 0),
    });
    const lat = affected.reduce((s, d) => s + repPos(d).lat, 0) / affected.length;
    const lon = affected.reduce((s, d) => s + repPos(d).lon, 0) / affected.length;
    const radius = Math.max(350, ...affected.map(d => distanceM(lat, lon, repPos(d).lat, repPos(d).lon) + 220));
    const existing = this.zones.find(z => z.id === DYNAMIC_ZONE_ID);
    if (existing) {
      // Smooth the estimate so the zone glides instead of jumping between ticks.
      const [pLat, pLon] = existing.center!;
      existing.center = [pLat + (lat - pLat) * 0.25, pLon + (lon - pLon) * 0.25];
      existing.radius_m = existing.radius_m! + (radius - existing.radius_m!) * 0.25;
      this.zones = [...this.zones];
      return;
    }

    this.milestones.add('interference');
    this.zones = [...this.zones, {
      id: DYNAMIC_ZONE_ID, name: 'Mobile EW Interference (estimated)', zone_type: 'INTERFERENCE',
      geometry_type: 'CIRCLE', center: [lat, lon], radius_m: radius, is_active: true, detected_by: 'ORION_CONSENSUS',
    }];
    const affectedIds = affected.map(d => d.id);
    const reallocatedTo = this.drones
      .filter(d => !affectedIds.includes(d.id) && d.spoofedAt === null && d.mode !== 'LANDED')
      .map(d => d.id);
    this.log('ZONE_INTERFERENCE_MARKED', null, {
      sector: affected[0].sector.name, affected_drones: affectedIds, reallocated_to: reallocatedTo,
      action: 'Consensus: several drones lost GPS together. EW zone mapped and tracked; patrol reallocated outside',
    }, 'ORION_CONSENSUS');
  }

  /** Link-loss policy from the spec: after N seconds, apply RTL or loiter, filtered by zone rules. */
  private updateLinks(): void {
    for (const d of this.drones) {
      if (d.linkLostAt === null) continue;
      const down = this.elapsed - d.linkLostAt;
      if (!d.failsafeDone && down >= LINK_LOSS.failsafeAfterS && d.mode !== 'LANDED') {
        d.failsafeDone = true;
        const state = this.states().find(s => s.drone_id === d.id)!;
        const rtl = evaluateActions(state, this.zones).find(a => a.id === 'RETURN_TO_HOME')!;
        const applied = rtl.allowed ? 'RETURN_TO_HOME' : 'LOITER';
        this.log('FAILSAFE_APPLIED', d.id, {
          policy: 'RETURN_TO_HOME', applied, link_lost_s: Math.round(down),
          reason: rtl.allowed ? 'Path to base is clear' : `RTL blocked by zone rules: ${rtl.reason}. Holding position instead`,
        }, 'ORION_FAILSAFE');
        this.dispatch(d.id, applied, 'ORION_FAILSAFE');
      }
      if (down >= LINK_LOSS.durationS) {
        d.linkLostAt = null;
        this.log('COMMAND_LINK_RESTORED', d.id, {
          description: 'Link back. Drone keeps its failsafe action until the operator decides',
        });
      }
    }
  }

  private linkDown(d: SimDrone): boolean {
    return d.linkLostAt !== null;
  }

  private move(d: SimDrone, dt: number): void {
    if (d.mode === 'PATROL') {
      const { center, orbit } = d.sector;
      const targetLat = center.lat + orbit.lat * Math.sin(d.angle);
      const targetLon = center.lon + orbit.lon * Math.cos(d.angle);
      const dist = distanceM(d.lat, d.lon, targetLat, targetLon);
      const budget = EGRESS_SPEED_MS * dt;
      if (dt > 0 && dist > budget * 1.5) {
        const f = budget / dist;
        d.lat += (targetLat - d.lat) * f;
        d.lon += (targetLon - d.lon) * f;
      } else {
        d.angle += ANGULAR_SPEED * dt;
        d.lat = center.lat + orbit.lat * Math.sin(d.angle);
        d.lon = center.lon + orbit.lon * Math.cos(d.angle);
      }
      return;
    }
    if (d.mode === 'LOITER') {
      if (d.egressPath.length && this.elapsed >= d.loiterUntil) d.mode = 'EGRESS';
      return;
    }
    if (d.mode === 'EGRESS' && d.route === 'ROUTE' && this.routeLegBlocked(d)) {
      // A zone moved onto the planned route: re-plan from here, or hold if nothing is safe.
      const state = this.states().find(s => s.drone_id === d.id)!;
      const replanned = egressPaths(state, this.zones).viaRoute;
      d.egressLeg = 0;
      if (replanned.length) {
        d.egressPath = replanned;
      } else {
        d.mode = 'LOITER';
        d.loiterUntil = Infinity;
        d.egressPath = [];
      }
      this.log('ROUTE_REPLANNED', d.id, {
        reason: 'A hazard zone now crosses the planned route',
        result: replanned.length ? `${replanned.length - 1} legs` : 'No safe route: holding (LOITER)',
      }, 'ORION_PATHFINDER');
      return;
    }
    if (d.mode === 'EGRESS') {
      let budget = EGRESS_SPEED_MS * dt;
      // Egress paths are in the drone's reported (possibly spoofed) frame; strip the offset while moving.
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
        this.log('DRONE_RECOVERED', d.id, { location: 'Base Forward Alpha', via: d.route === 'RTL' ? 'Direct return-to-home' : d.route === 'ROUTE' ? 'Computed safe route (A*)' : 'Safe Corridor Alpha' });
      }
    }
  }

  /** True when the leg being flown now crosses a hazard the drone isn't already inside. */
  private routeLegBlocked(d: SimDrone): boolean {
    const target = d.egressPath[d.egressLeg + 1];
    if (!target) return false;
    const off = d.spoofedAt !== null ? SPOOF_OFFSET : { lat: 0, lon: 0 };
    const lat = d.lat + off.lat, lon = d.lon + off.lon;
    return hazardZones(this.zones).some(z =>
      distanceM(lat, lon, z.center![0], z.center![1]) > z.radius_m! &&
      segmentIntersectsCircle(lat, lon, target[1], target[0], z.center![0], z.center![1], z.radius_m!));
  }

  private states(): DroneState[] {
    const ts = new Date().toISOString();
    return this.drones.map(d => {
      const spoofed = d.spoofedAt !== null;
      const jammed = d.jammedAt !== null;
      const linkLost = this.linkDown(d);
      let lat = d.lat, lon = d.lon;
      let fix = 3, sats = 12, eph = 1.0, drop = 0.5, rssi = 95;
      if (spoofed) { lat += SPOOF_OFFSET.lat; lon += SPOOF_OFFSET.lon; sats = 4; eph = 4.2; fix = 2; }
      if (jammed) { sats = 3; fix = 1; eph = 6.0; drop = 35; rssi = 25; }
      if (linkLost) { drop = 95; rssi = 3; }
      // Weather degrades the link and position hold; ORION knows it's weather, not EW.
      const wx = weatherAt(this.zones, lat, lon);
      const fx = weatherEffects(wx);
      drop = Math.round((drop + fx.dropAdd) * 10) / 10;
      rssi = Math.max(0, rssi - fx.rssiLoss);
      eph = Math.round((eph + fx.ephAdd) * 100) / 100;

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
        const peersHit = this.drones.filter(p => p !== d && p.jammedAt !== null).length;
        consensus = Math.min(consensus, peersHit ? 60 : 85);
        reasons.push(
          'GPS lost, dead reckoning active',
          peersHit ? 'Peers in same area degraded: localized interference' : 'Peers nominal: drone-level fault',
        );
      }
      if (sats < 6 && !spoofed && !jammed) reasons.push('Low satellite count');
      const link = Math.max(0, Math.min(100, rssi, 100 - drop * 2));
      if (linkLost) reasons.push('Command link lost: onboard failsafe in control');
      else if (link < 60) reasons.push('Command link degraded');
      if (wx) reasons.push(`Weather: ${wx.name} (${describeWeather(wx)}), link/battery effects are weather, not EW`);

      let score = 0.3 * gps + 0.3 * imu + 0.2 * link + 0.2 * consensus;
      if (imu <= 20 || unc >= 100) score = Math.min(score, 35);
      if (linkLost) score = Math.min(score, 55); // position may be fine, but we can't steer it
      score = Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
      const status: TrustStatus = score >= 75 ? 'GREEN' : score >= 40 ? 'YELLOW' : 'RED';
      const reason = reasons.length ? reasons.join('; ') : 'Sensors & consensus nominal';

      const flightMode = d.mode === 'PATROL' ? 'GUIDED' : d.mode === 'EGRESS' ? d.route : d.mode;
      return {
        drone_id: d.id, latitude: lat, longitude: lon, altitude: d.mode === 'LANDED' ? 0 : 120,
        ground_speed: d.mode === 'PATROL' ? 12 : d.mode === 'EGRESS' ? EGRESS_SPEED_MS : 0,
        heading: ((d.angle * 180) / Math.PI + 90) % 360,
        fix_type: fix, satellites_visible: sats, eph,
        battery_remaining: Math.round(Math.max(20, 100 - d.batteryUsed) * 10) / 10,
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
    const withTime = { ...details, mission_time_s: this.elapsed };
    this.ledger.append(type, droneId, withTime, operator).then(() => this.cb.onLedger());
  }

  private drone(id: number): SimDrone {
    return this.drones.find(d => d.id === id)!;
  }
}
