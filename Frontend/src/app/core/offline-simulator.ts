import { ActionOption, circleRing, evaluateActions, egressPaths, distanceM, hazardZones, orderPolygonVertices, planTargetRoute, segmentIntersectsCircle, weatherAt } from './geo';
import { WEATHER_TEMPLATES, describeWeather, isSevereWeather, isWeather, weatherEffects } from './platform';
import { computeMesh, describeMesh } from './mesh';
import { HOLD_CLIMB_M, holdPoint, isOnOrbit, spacingRates } from './patrol';
import { HashChainLedger } from './hash-chain';
import { DroneState, FleetUpdate, Recommendation, TrustStatus, WeatherKind, Zone } from './models';
import { AdversaryMoveKind, AdversaryOptions } from './training';
import { RadioKind, dronesIn } from './radio';

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
const CRUISE_ALT_M = 120;

// Hostile mobile EW emitter: enters from the south-east, crosses Sector 4, withdraws into Bravo.
const JAMMER = {
  path: [[44.329, 23.842], [44.335, 23.83], [44.341, 23.848]] as [number, number][],
  speedMs: 45,
  radiusM: 430,
};

const LINK_LOSS = { droneId: 5, durationS: 15, failsafeAfterS: 5 };

const SCRIPT = { spoof: 30, recommend: 60, replay: 100, jammer: 112, linkLoss: 145, report: 160 };

const DYNAMIC_ZONE_ID = 100;

/** In training, how long ORION takes to notice an attack and put a decision to the operator. */
const DETECTION_DELAY_S = 3;
/** In training, at most this many drones are spoofed at once: pressure, not a wipe-out. */
const MAX_SPOOFED = 2;

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
  {
    id: 4,
    name: 'Restricted Threat Zone Bravo',
    zone_type: 'THREAT',
    geometry_type: 'POLYGON',
    waypoints: [[44.3445, 23.84], [44.34225, 23.84545], [44.33775, 23.84545], [44.3355, 23.84], [44.33775, 23.83455], [44.34225, 23.83455]],
    center: [44.34, 23.84],
    radius_m: 500,
    is_active: true,
    detected_by: 'PRECONFIGURED',
  },
  { id: 10, name: 'Patrol Zone Alpha', zone_type: 'PATROL', geometry_type: 'CIRCLE', center: [44.335, 23.83], radius_m: 350, is_active: true, detected_by: 'PRECONFIGURED' },
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
  patrol_zone_id?: number;
  targetMode?: 'PATROL' | 'LOITER';
  targetPoint?: [number, number];
  targetZoneId?: number;
  pathType?: 'SAFE' | 'RISKY';
  mode: 'PATROL' | 'LOITER' | 'EGRESS' | 'LANDED';
  loiterUntil: number;
  egressPath: [number, number][]; // [lon, lat]
  egressLeg: number;
  route: 'RTL' | 'CORRIDOR' | 'ROUTE';
  batteryUsed: number; // % drained; weather makes it drain faster
  weatherAlert: number | null; // id of the over-limit weather zone already reported
  onOrbit: boolean; // flying the patrol orbit (not still on the way to it)
  patrolRate: number; // rad/s around the orbit, set by the spacing coordinator (core/patrol.ts)
  /** Where a loitering drone holds off the orbit: undefined = not decided yet, null = in place. */
  holdPoint?: [number, number] | null;
  repositioning: boolean;
  altitude: number;
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
  /**
   * The fixed 3-minute script. Off during AI training (core/training.ts): the adversary then
   * stages the attacks through applyAdversaryMove() and ORION raises a decision for each one.
   */
  scripted = true;

  private drones: SimDrone[] = [];
  private zones: Zone[] = [];
  private recs: Recommendation[] = [];
  private milestones = new Set<string>();
  /** Drones on each sector's orbit at the last tick, by sector name. */
  private patrolMembers = new Map<string, Set<number>>();
  private jammer: Jammer | null = null;
  /** Attacks ORION will turn into a recommendation once it has noticed them (training only). */
  private detections: { droneId: number; at: number; trigger: string }[] = [];
  /** Scripted radio chatter waiting to be "said" (exercise colour, marked simulated in the log). */
  private radioCues: { at: number; speaker: string; text: string; kind: RadioKind }[] = [];
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
    this.detections = [];
    this.radioCues = [];
    this.zones = structuredClone(INITIAL_ZONES);
    SECTORS.A.center = { lat: 44.335, lon: 23.83 };
    SECTORS.A.orbit = { lat: 0.003, lon: 0.004 };
    const fleet: [Sector, number][] = [
      [SECTORS.A, 0], [SECTORS.A, Math.PI / 2], [SECTORS.A, Math.PI], [SECTORS.A, (3 * Math.PI) / 2],
      [SECTORS.B, Math.PI / 4], [SECTORS.B, (5 * Math.PI) / 4],
    ];
    this.drones = fleet.map(([sector, angle], i) => ({
      id: i + 1, sector, angle, lat: 0, lon: 0, spoofedAt: null, jammedAt: null, linkLostAt: null, failsafeDone: false,
      safeAirspaceTime: 0, patrol_zone_id: sector === SECTORS.B ? 100 : 10, mode: 'PATROL', loiterUntil: 0, egressPath: [], egressLeg: 0, route: 'CORRIDOR',
      batteryUsed: 0, weatherAlert: null, onOrbit: true, patrolRate: ANGULAR_SPEED,
      repositioning: false, altitude: CRUISE_ALT_M,
    }));
    this.patrolMembers = new Map(
      Object.values(SECTORS).map(s => [s.name, new Set(this.drones.filter(d => d.sector === s).map(d => d.id))]),
    ); // the starting formation
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

    if (this.scripted) {
      if (this.elapsed >= SCRIPT.spoof) this.triggerSpoofing();
      if (this.elapsed >= SCRIPT.recommend) this.issueRecommendation();
      if (this.elapsed >= SCRIPT.replay) this.triggerReplay();
      if (this.elapsed >= SCRIPT.jammer) this.triggerInterference();
      if (this.elapsed >= SCRIPT.linkLoss) this.triggerLinkLoss();
      if (this.elapsed >= SCRIPT.report) this.markReportReady();
    }
    this.raiseDetections();
    this.playRadio();

    this.moveJammer(dt);
    this.driftWeather(dt);
    this.coordinatePatrol();
    this.checkPatrolJamming();
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
  addPatrolZone(name: string, center: [number, number], radiusM: number): Zone {
    const zone: Zone = {
      id: 200 + this.zones.length,
      name: name || `Patrol Zone ${this.zones.length + 1}`,
      zone_type: 'PATROL',
      geometry_type: 'CIRCLE',
      center: [...center],
      radius_m: radiusM,
      is_active: true,
      detected_by: 'OPERATOR',
    };
    this.zones = [...this.zones, zone];
    this.log('PATROL_ZONE_CREATED', null, { zone_id: zone.id, name: zone.name, center, radius_m: radiusM }, 'OPERATOR_1');
    return zone;
  }

  addThreatZone(name: string, waypoints?: [number, number][], center?: [number, number], radiusM?: number): Zone {
    const count = this.zones.filter(z => z.zone_type === 'THREAT' && z.is_active).length;
    const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
    const label = greek[count] ?? `Sector-${count + 1}`;
    let cleanPts: [number, number][];
    let c: [number, number];
    let r: number;
    if (waypoints && waypoints.length >= 3) {
      cleanPts = orderPolygonVertices(waypoints);
      const cLat = cleanPts.reduce((a, b) => a + b[0], 0) / cleanPts.length;
      const cLon = cleanPts.reduce((a, b) => a + b[1], 0) / cleanPts.length;
      c = [cLat, cLon];
      r = Math.max(...cleanPts.map(p => distanceM(cLat, cLon, p[0], p[1])));
    } else {
      c = center || [44.34, 23.84];
      r = radiusM || 400;
      cleanPts = circleRing(c[0], c[1], r, 6).slice(0, 6);
    }
    const zone: Zone = {
      id: 300 + this.zones.length,
      name: name || `Restricted Threat Zone ${label}`,
      zone_type: 'THREAT',
      geometry_type: 'POLYGON',
      waypoints: cleanPts,
      center: c,
      radius_m: Math.round(r),
      is_active: true,
      detected_by: 'OPERATOR',
    };
    this.zones = [...this.zones, zone];
    this.log('THREAT_ZONE_DECLARED', null, { zone_id: zone.id, name: zone.name, waypoints: zone.waypoints, center: zone.center, radius_m: zone.radius_m }, 'OPERATOR_1');
    return zone;
  }

  addSafeCorridor(name: string, waypoints: [number, number][]): Zone {
    const count = this.zones.filter(z => z.zone_type === 'SAFE_CORRIDOR' && z.is_active).length;
    const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
    const label = greek[count] ?? `Route-${count + 1}`;
    const zone: Zone = {
      id: 400 + this.zones.length,
      name: name || `Safe Corridor ${label}`,
      zone_type: 'SAFE_CORRIDOR',
      geometry_type: 'POLYGON',
      waypoints: waypoints.map(pt => [pt[0], pt[1]]),
      is_active: true,
      detected_by: 'OPERATOR',
    };
    this.zones = [...this.zones, zone];
    this.log('SAFE_CORRIDOR_DECLARED', null, { corridor_id: zone.id, name: zone.name, waypoints: zone.waypoints }, 'OPERATOR_1');
    return zone;
  }

  addObjectiveZone(name: string, waypoints: [number, number][]): Zone {
    const cleanPts: [number, number][] = orderPolygonVertices(waypoints);
    const count = this.zones.filter(z => z.zone_type === 'OBJECTIVE' && z.is_active).length;
    const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
    const label = greek[count] ?? `Sector-${count + 1}`;
    const zone: Zone = {
      id: 500 + this.zones.length,
      name: name || `Objective Zone ${label}`,
      zone_type: 'OBJECTIVE',
      geometry_type: 'POLYGON',
      waypoints: cleanPts.map(pt => [pt[0], pt[1]] as [number, number]),
      is_active: true,
      detected_by: 'OPERATOR',
    };
    this.zones = [...this.zones, zone];
    this.log('OBJECTIVE_ZONE_DECLARED', null, { zone_id: zone.id, name: zone.name, waypoints: zone.waypoints }, 'OPERATOR_1');
    return zone;
  }

  deployDrone(): SimDrone {
    const nextId = Math.max(0, ...this.drones.map(d => d.id)) + 1;
    const baseLat = 44.316;
    const baseLon = 23.8;
    const angle = Math.random() * 2 * Math.PI;
    const distM = 20 + Math.random() * 40;
    const dlat = (distM * Math.cos(angle)) / 111139.0;
    const dlon = (distM * Math.sin(angle)) / (111139.0 * Math.cos((baseLat * Math.PI) / 180));
    const lat = Number((baseLat + dlat).toFixed(6));
    const lon = Number((baseLon + dlon).toFixed(6));

    const newDrone: SimDrone = {
      id: nextId,
      sector: SECTORS.A,
      angle: 0,
      lat,
      lon,
      spoofedAt: null,
      jammedAt: null,
      linkLostAt: null,
      failsafeDone: false,
      safeAirspaceTime: 0,
      patrol_zone_id: 10,
      mode: 'LOITER',
      loiterUntil: Infinity,
      egressPath: [],
      egressLeg: 0,
      route: 'CORRIDOR',
      batteryUsed: 0,
      weatherAlert: null,
      onOrbit: false,
      patrolRate: 0.08,
      holdPoint: [lat, lon],
      repositioning: false,
      altitude: 120,
    };
    this.drones.push(newDrone);
    this.log(
      'DRONE_DEPLOYED',
      nextId,
      {
        location: 'Base Forward Alpha',
        coordinates: [lat, lon],
        description: `Drone ${nextId} deployed in Base Forward zone (mode: LOITER)`,
        mission_time_s: this.elapsed,
      },
      'OPERATOR_1',
    );
    return newDrone;
  }

  executeZoneTactic(zoneId: number, tactic: string, operatorId = 'OPERATOR_1'): { ok: boolean; message: string } {
    const pz = this.zones.find(z => z.id === zoneId && z.zone_type === 'PATROL');
    if (!pz) return { ok: false, message: 'Patrol zone not found.' };

    const tacticUpper = tactic.toUpperCase();
    let zoneDrones = this.drones.filter(d => (d.patrol_zone_id ?? (d.sector === SECTORS.B ? 100 : 10)) === zoneId);
    if (!zoneDrones.length && (zoneId === 10 || zoneId === 100)) {
      zoneDrones = this.drones.filter(d => d.sector === SECTORS.A);
    }

    if (tacticUpper === 'SECTOR_ORBIT_SHIFT') {
      const jammer = this.zones.find(z => z.is_active && z.zone_type === 'INTERFERENCE' && z.center && z.radius_m);
      if (jammer && pz.center && pz.radius_m) {
        const vLat = pz.center[0] - jammer.center![0];
        const vLon = pz.center[1] - jammer.center![1];
        const mag = Math.hypot(vLat, vLon) || 0.001;
        const shiftM = 280;
        const shiftLat = (shiftM / M_PER_DEG_LAT) * (vLat / mag);
        const shiftLon = (shiftM / (M_PER_DEG_LAT * Math.cos((pz.center[0] * Math.PI) / 180))) * (vLon / mag);
        pz.center = [pz.center[0] + shiftLat, pz.center[1] + shiftLon];
      } else if (pz.center) {
        pz.center = [pz.center[0] + 0.002, pz.center[1] + 0.002];
      }
      if (pz.center) {
        SECTORS.A.center = { lat: pz.center[0], lon: pz.center[1] };
        for (const d of zoneDrones) {
          if (d.sector) d.sector.center = { lat: pz.center[0], lon: pz.center[1] };
        }
      }
      for (const d of zoneDrones) {
        d.jammedAt = null;
        d.spoofedAt = null;
        d.safeAirspaceTime = 10;
        d.onOrbit = false;
        if (d.mode === 'LOITER') d.mode = 'PATROL';
      }
      this.zones = [...this.zones];
      this.log('PATROL_TACTIC_EXECUTED', null, { zone_id: zoneId, tactic: 'SECTOR_ORBIT_SHIFT', new_center: pz.center }, operatorId);
      return { ok: true, message: 'Sector Orbit Shift executed. Swarm shifted to clear airspace.' };
    } else if (tacticUpper === 'TIGHT_MESH') {
      const baseR = (pz as any)['base_radius_m'] ?? pz.radius_m ?? 350;
      (pz as any)['base_radius_m'] = baseR;
      pz.radius_m = Math.round(Math.max(100, baseR * 0.6));
      const scale = pz.radius_m / 350;
      SECTORS.A.orbit = { lat: 0.003 * scale, lon: 0.004 * scale };
      for (const d of zoneDrones) {
        if (d.sector) d.sector.orbit = { lat: 0.003 * scale, lon: 0.004 * scale };
        d.onOrbit = false;
        if (d.mode === 'LOITER') d.mode = 'PATROL';
      }
      this.zones = [...this.zones];
      this.log('PATROL_TACTIC_EXECUTED', null, { zone_id: zoneId, tactic: 'TIGHT_MESH', radius_m: pz.radius_m }, operatorId);
      return { ok: true, message: `Tight Mesh Formation activated (${pz.radius_m}m).` };
    } else if (tacticUpper === 'WIDE_RECON') {
      const baseR = (pz as any)['base_radius_m'] ?? pz.radius_m ?? 350;
      (pz as any)['base_radius_m'] = baseR;
      pz.radius_m = Math.round(Math.min(800, baseR * 1.45));
      const scale = pz.radius_m / 350;
      SECTORS.A.orbit = { lat: 0.003 * scale, lon: 0.004 * scale };
      for (const d of zoneDrones) {
        if (d.sector) d.sector.orbit = { lat: 0.003 * scale, lon: 0.004 * scale };
        d.onOrbit = false;
        if (d.mode === 'LOITER') d.mode = 'PATROL';
      }
      this.zones = [...this.zones];
      this.log('PATROL_TACTIC_EXECUTED', null, { zone_id: zoneId, tactic: 'WIDE_RECON', radius_m: pz.radius_m }, operatorId);
      return { ok: true, message: `Dispersed Wide Recon activated (${pz.radius_m}m).` };
    } else if (tacticUpper === 'RESYNC_EQUIDISTANT') {
      if (zoneDrones.length > 0) {
        const stepAngle = (2 * Math.PI) / zoneDrones.length;
        const baseAngle = zoneDrones[0].angle;
        zoneDrones.forEach((d, idx) => {
          d.angle = (baseAngle + idx * stepAngle) % (2 * Math.PI);
          d.patrolRate = ANGULAR_SPEED;
          d.onOrbit = false;
          if (d.mode === 'LOITER') d.mode = 'PATROL';
        });
      }
      this.log('PATROL_TACTIC_EXECUTED', null, { zone_id: zoneId, tactic: 'RESYNC_EQUIDISTANT' }, operatorId);
      return { ok: true, message: 'Equidistant Phase Resynchronization activated.' };
    } else if (tacticUpper === 'EGRESS_CORRIDOR') {
      for (const d of zoneDrones) {
        if (d.mode === 'PATROL' || d.mode === 'LOITER') {
          this.command(d.id, 'SAFE_CORRIDOR_RETREAT', operatorId);
        }
      }
      this.log('PATROL_TACTIC_EXECUTED', null, { zone_id: zoneId, tactic: 'EGRESS_CORRIDOR' }, operatorId);
      return { ok: true, message: 'Emergency Egress ordered via safe corridor.' };
    }
    return { ok: false, message: `Unknown tactic ${tactic}.` };
  }

  checkPatrolJamming(): void {
    const jammers = this.zones.filter(z => z.is_active && z.zone_type === 'INTERFERENCE' && z.center && z.radius_m);
    if (!jammers.length) return;
    const patrols = this.zones.filter(z => z.is_active && z.zone_type === 'PATROL' && z.center && z.radius_m);
    for (const pz of patrols) {
      const isJammed = jammers.some(j => distanceM(pz.center![0], pz.center![1], j.center![0], j.center![1]) <= (pz.radius_m! + j.radius_m!));
      if (isJammed) {
        const existing = this.recs.find(r => r.trigger_event === 'PATROL_ZONE_JAMMED' && r.drone_id === pz.id);
        if (!existing) {
          const rec = {
            id: this.recs.length + 1,
            drone_id: pz.id,
            trigger_event: 'PATROL_ZONE_JAMMED',
            blocked_action: 'NONE',
            blocked_reason: '',
            recommended_action: 'SECTOR_ORBIT_SHIFT',
            status: 'PENDING' as const,
            reason: 'Active EW Jamming overlaps ' + pz.name + '. Shift patrol orbit to clear airspace to preserve swarm communications and GPS navigation integrity.',
            recommendation_details: '1. Displace patrol orbit center away from active EW jammer vector. 2. Maintain equidistant swarm spacing (360° / N) in safe airspace. 3. Preserve RF/mesh cross-ranging and communication line of sight.',
            operator_id: null,
            approved_at: null,
            timestamp: new Date().toISOString(),
          };
          this.recs = [rec, ...this.recs];
          this.log('RECOMMENDATION_ISSUED', null, { recommendation_id: rec.id, patrol_zone: pz.name, action: rec.recommended_action }, 'AUTONOMOUS');
        }
      }
    }
  }

  deleteZone(zoneId: number): boolean {
    const z = this.zones.find(zone => zone.id === zoneId);
    if (!z) return false;
    z.is_active = false;
    this.zones = [...this.zones];
    this.log('ZONE_DELETED', null, { zone_id: zoneId, name: z.name, zone_type: z.zone_type }, 'OPERATOR_1');
    return true;
  }

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
    this.saySpoofed(2);
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
      trigger_event: rtl.allowed ? 'SPOOFING_ATTACK_DETECTED' : 'TRUST_DEGRADED_EW_HAZARD',
      blocked_action: rtl.allowed ? 'CONTINUE_PATROL' : 'RETURN_TO_HOME',
      blocked_reason: rtl.allowed ? 'GPS ephemeris corrupted by spoofing attack; patrol trajectory compromised' : `Direct Return-to-Home route blocked: ${rtl.reason}`,
      recommended_action: rtl.allowed ? 'LOITER' : 'LOITER_THEN_SAFE_CORRIDOR_RETREAT',
      reason: rtl.allowed
        ? 'Adversary GPS spoofing detected (sudden ephemeris jump). Action needed: Continuing patrol with corrupted GPS coordinates will drive the drone off course into danger; immediate LOITER is required to hold position and stabilize onboard EKF/IMU.'
        : 'Hostile electronic warfare hazard active: Direct path to Base is compromised by EW jamming. Action needed: Direct RTL will cause complete C2 link loss; drone must immediately loiter and divert through Safe Corridor Alpha.',
      recommendation_details: rtl.allowed
        ? '1. Command immediate LOITER to hold position and stabilize flight. 2. Allow onboard EKF/IMU filters to stabilize. 3. Await sensor recalibration before continuing patrol.'
        : '1. Command immediate LOITER to stabilize. 2. Steer egress via Safe Corridor Alpha (avoiding EW Jamming Zone Sector 4) to Base.',
      status: 'PENDING',
      operator_id: null,
      approved_at: null,
    };
    this.recs = [rec, ...this.recs];
    this.sayLater(3, 'TOC', 'Am văzut recomandarea ORION pentru D2. Decizia e la operator, nu întârziați.', 'ORDER');
    this.log('RECOMMENDATION_ISSUED', 2, {
      recommendation_id: rec.id, blocked_action: rec.blocked_action,
      blocked_reason: rec.blocked_reason, recommended_action: rec.recommended_action,
    }, 'ORION_THEATRE_RULES');
    this.cb.onRecommendations(this.recs);
  }

  triggerReplay(): void {
    if (this.milestones.has('replay')) return;
    this.milestones.add('replay');
    this.sayLater(2, 'OPERATOR_2', 'Comandă de întoarcere respinsă pentru D2, secvență veche. Cineva reia comenzi pe canal.');
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
    this.sayLinkLost(d.id);
    this.log('COMMAND_LINK_LOST', d.id, {
      description: 'Command link jammed: no telemetry acknowledgements',
      failsafe_in_s: LINK_LOSS.failsafeAfterS,
    }, 'SIMULATOR');
  }

  // ---- AI training: what the adversary may do now, and doing it ---------------------------

  /** The adversary's menu right now: only events this simulation can stage (core/training.ts). */
  adversaryOptions(): AdversaryOptions {
    const flying = this.drones.filter(d => d.mode !== 'LANDED' && !this.linkDown(d));
    const weather = this.zones.filter(z => z.is_active && isWeather(z));
    const available: AdversaryMoveKind[] = ['REPLAY'];
    const spoofed = this.drones.filter(d => d.spoofedAt !== null).length;
    const eligible: AdversaryOptions['eligible'] = {
      SPOOF: spoofed >= MAX_SPOOFED ? [] : flying.filter(d => d.spoofedAt === null).map(d => d.id),
      LINK_LOSS: flying.map(d => d.id),
    };
    if (eligible.SPOOF.length) available.push('SPOOF');
    if (eligible.LINK_LOSS.length) available.push('LINK_LOSS');
    if (!this.jammer || this.jammer.leg >= JAMMER.path.length - 1) available.push('JAMMER');
    if (weather.length < 2) {
      for (const kind of ['STORM', 'WIND', 'RAIN'] as const) {
        if (!weather.some(z => z.weather === kind)) available.push(kind);
      }
    }
    return { available, eligible };
  }

  /** Stages one adversary move; false when it isn't possible right now (then nothing happens). */
  applyAdversaryMove(move: AdversaryMoveKind, target: number | null, by = 'AI_ADVERSARY'): boolean {
    const options = this.adversaryOptions();
    if (move === 'WAIT') return true;
    if (!options.available.includes(move)) return false;
    if (move === 'SPOOF') {
      if (target === null || !options.eligible.SPOOF.includes(target)) return false;
      this.drone(target).spoofedAt = this.elapsed;
      this.saySpoofed(target);
      this.log('SPOOFING_ATTACK_INITIATED', target, {
        attack_vector: 'GPS_SPOOFING_INJECTION', target: `Drone ${target}`,
        description: 'False ephemeris and sudden position jump injected',
      }, by);
      this.detections.push({ droneId: target, at: this.elapsed + DETECTION_DELAY_S, trigger: 'SPOOFING_ATTACK_DETECTED' });
    } else if (move === 'LINK_LOSS') {
      if (target === null || !options.eligible.LINK_LOSS.includes(target)) return false;
      const d = this.drone(target);
      d.linkLostAt = this.elapsed;
      d.failsafeDone = false;
      this.sayLinkLost(d.id);
      this.log('COMMAND_LINK_LOST', d.id, {
        description: 'Command link jammed: no telemetry acknowledgements', failsafe_in_s: LINK_LOSS.failsafeAfterS,
      }, by);
    } else if (move === 'JAMMER') {
      const [lat, lon] = JAMMER.path[0];
      this.jammer = { lat, lon, leg: 0 };
      this.milestones.delete('single-fault');
      this.log('EW_EMITTER_ACTIVE', null, {
        description: 'Simulated hostile mobile jammer starts transmitting south-east of Sector 4',
      }, by);
    } else if (move === 'REPLAY') {
      const victims = this.drones.filter(d => d.mode !== 'LANDED');
      const victim = victims[Math.floor(this.elapsed) % victims.length] ?? this.drones[0];
      this.log('COMMAND_REPLAY_REJECTED', victim.id, {
        command: 'RETURN_TO_HOME', sequence: Math.max(1, this.commandSeq - 3), age_s: 30,
        reason: 'Replay detected: sequence already consumed and timestamp expired',
        signature: 'fabricated_or_replayed_signature_deadbeef1234',
      }, by);
    } else {
      this.triggerWeather(move);
    }
    this.emit();
    return true;
  }

  /** Turns attacks ORION has now noticed into decisions for the operator (training only). */
  private raiseDetections(): void {
    if (!this.detections.length) return;
    const due = this.detections.filter(x => this.elapsed >= x.at);
    this.detections = this.detections.filter(x => this.elapsed < x.at);
    for (const { droneId, trigger } of due) {
      const d = this.drone(droneId);
      const stillHit = trigger === 'SPOOFING_ATTACK_DETECTED' ? d.spoofedAt !== null : d.jammedAt !== null;
      if (d.mode !== 'LANDED' && stillHit && !this.linkDown(d)) this.recommendFor(droneId, trigger);
    }
  }

  // ---- radio log ---------------------------------------------------------------------------

  /** A transcribed push-to-talk transmission, timed from when the mic was keyed. */
  logRadio(transcript: string, speaker: string, details: Record<string, unknown> & { duration_s: number; drones?: number[] }): void {
    const drones = details.drones ?? dronesIn(transcript);
    this.log('RADIO_TRANSMISSION', drones.length === 1 ? drones[0] : null, {
      transcript, channel: 'COMMAND_NET',
      mission_time_s: Math.max(0, Math.round((this.elapsed - details.duration_s) * 10) / 10),
      ...details, drones,
    }, speaker);
  }

  private sayLater(delayS: number, speaker: string, text: string, kind: RadioKind = 'REPORT'): void {
    this.radioCues.push({ at: this.elapsed + delayS, speaker, text, kind });
  }

  private playRadio(): void {
    if (!this.radioCues.length) return;
    const due = this.radioCues.filter(c => this.elapsed >= c.at);
    this.radioCues = this.radioCues.filter(c => this.elapsed < c.at);
    for (const c of due) {
      const drones = dronesIn(c.text);
      this.log('RADIO_TRANSMISSION', drones.length === 1 ? drones[0] : null, {
        transcript: c.text, channel: 'COMMAND_NET', simulated: true, drones, kind: c.kind,
        duration_s: Math.max(2, Math.round(c.text.length / 14)),
      }, c.speaker);
    }
  }

  private saySpoofed(droneId: number): void {
    this.sayLater(4, 'OPERATOR_2', `Atenție, D${droneId} a sărit pe hartă cu vreo 500 de metri. Nu e real, verific poziția.`);
  }

  private sayLinkLost(droneId: number): void {
    this.sayLater(2, 'TOC', `D${droneId} nu mai răspunde la comenzi. Lăsăm failsafe-ul să lucreze, nu forțăm.`, 'ORDER');
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
  command(
    droneId: number,
    action: string,
    operatorId: string,
    targetZoneId?: number,
    targetPoint?: [number, number],
    pathType: 'SAFE' | 'RISKY' = 'SAFE',
  ): { ok: boolean; message: string } {
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
    const seq = this.dispatch(droneId, action, operatorId, targetZoneId, targetPoint, pathType);
    return { ok: true, message: `Signed ${action} sent to Drone ${droneId} (seq ${seq}).` };
  }

  private dispatch(
    droneId: number,
    action: string,
    operatorId: string,
    targetZoneId?: number,
    targetPoint?: [number, number],
    pathType: 'SAFE' | 'RISKY' = 'SAFE',
  ): number {
    const seq = this.commandSeq++;
    this.log('COMMAND_EXECUTED', droneId, {
      command: action, sequence: seq, signed: true, signing: 'MAVLINK2_HMAC_SHA256',
    }, operatorId);

    const d = this.drone(droneId);
    d.safeAirspaceTime = 0;
    d.targetMode = undefined;
    d.targetPoint = undefined;
    d.targetZoneId = undefined;
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
      case 'JOIN_PATROL': {
        const zid = targetZoneId ?? d.patrol_zone_id ?? 10;
        let pZone = this.zones.find(z => z.id === zid && z.is_active && z.zone_type === 'PATROL');
        if (!pZone) {
          pZone = this.zones.find(z => z.is_active && z.zone_type === 'PATROL');
        }
        if (pZone && pZone.center) {
          const [cLat, cLon] = pZone.center;
          const rM = pZone.radius_m ?? 350;
          const cosLat = Math.cos((cLat * Math.PI) / 180);
          const ang = Math.atan2(d.lat - cLat, d.lon - cLon);
          const rLat = rM / 111139.0;
          const rLon = rM / (111139.0 * (cosLat || 1));
          const entryLat = cLat + rLat * Math.sin(ang);
          const entryLon = cLon + rLon * Math.cos(ang);
          const off = d.spoofedAt !== null ? SPOOF_OFFSET : { lat: 0, lon: 0 };
          const repLat = d.lat + off.lat;
          const repLon = d.lon + off.lon;
          const route = planTargetRoute([repLat, repLon], [entryLat, entryLon], this.zones, pathType);
          d.route = 'ROUTE';
          d.targetMode = 'PATROL';
          d.targetZoneId = pZone.id;
          d.patrol_zone_id = pZone.id;
          d.pathType = pathType;
          d.egressLeg = 0;
          if (route && route.waypoints.length > 1) {
            d.egressPath = route.waypoints.map(([la, lo]) => [lo, la] as [number, number]);
          } else {
            d.egressPath = [[repLon, repLat], [entryLon, entryLat]];
          }
          d.mode = 'EGRESS';
        }
        break;
      }
      case 'LOITER_AT': {
        const tPt: [number, number] = targetPoint && targetPoint.length === 2 ? targetPoint : [d.lat, d.lon];
        const off = d.spoofedAt !== null ? SPOOF_OFFSET : { lat: 0, lon: 0 };
        const repLat = d.lat + off.lat;
        const repLon = d.lon + off.lon;
        const route = planTargetRoute([repLat, repLon], [tPt[0], tPt[1]], this.zones, pathType);
        d.route = 'ROUTE';
        d.targetMode = 'LOITER';
        d.targetPoint = [tPt[0], tPt[1]];
        d.pathType = pathType;
        d.egressLeg = 0;
        if (route && route.waypoints.length > 1) {
          d.egressPath = route.waypoints.map(([la, lo]) => [lo, la] as [number, number]);
        } else {
          d.egressPath = [[repLon, repLat], [tPt[1], tPt[0]]];
        }
        d.mode = 'EGRESS';
        break;
      }
      case 'SECTOR_ORBIT_SHIFT':
      case 'TIGHT_MESH':
      case 'WIDE_RECON':
      case 'RESYNC_EQUIDISTANT':
      case 'EGRESS_CORRIDOR': {
        const zid = targetZoneId ?? d.patrol_zone_id ?? 10;
        this.executeZoneTactic(zid, action, operatorId);
        break;
      }
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
    if (d.safeAirspaceTime >= 5.0) {
      const wasSpoofed = d.spoofedAt !== null;
      d.spoofedAt = null;
      d.jammedAt = null;
      d.safeAirspaceTime = 0;
      if (wasSpoofed && d.egressPath.length > 0 && (d.mode === 'LOITER' || d.mode === 'EGRESS')) {
        // Recompute egress route from the restored true physical position
        const pathType = d.pathType ?? 'SAFE';
        if (d.targetMode === 'PATROL') {
          const pz = this.zones.find(z => z.id === d.patrol_zone_id && z.is_active && z.zone_type === 'PATROL');
          if (pz && pz.center) {
            const route = planTargetRoute([d.lat, d.lon], [pz.center[0], pz.center[1]], this.zones, pathType);
            d.egressPath = route && route.waypoints.length > 1
              ? route.waypoints.map(([la, lo]) => [lo, la] as [number, number])
              : [[d.lon, d.lat], [pz.center[1], pz.center[0]]];
          }
        } else if (d.targetMode === 'LOITER' && d.targetPoint) {
          const route = planTargetRoute([d.lat, d.lon], d.targetPoint, this.zones, pathType);
          d.egressPath = route && route.waypoints.length > 1
            ? route.waypoints.map(([la, lo]) => [lo, la] as [number, number])
            : [[d.lon, d.lat], [d.targetPoint[1], d.targetPoint[0]]];
        } else {
          const state = this.states().find(s => s.drone_id === d.id)!;
          const paths = egressPaths(state, this.zones);
          d.egressPath = d.route === 'RTL' ? paths.direct : d.route === 'ROUTE' ? paths.viaRoute : paths.viaCorridor;
        }
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
          reason: 'Sensor recalibration complete and verified in clean airspace. Action needed: Drone is holding idle in loiter; operator command is required to resume regular sector patrol.',
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
      if (inRange && d.jammedAt === null) {
        d.jammedAt = this.elapsed;
        if (!this.scripted) this.detections.push({ droneId: d.id, at: this.elapsed + DETECTION_DELAY_S, trigger: 'GPS_JAMMED' });
      }
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
    const names = affectedIds.map(i => 'D' + i);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} și ${names.at(-1)}` : names[0];
    this.sayLater(2, 'OPERATOR_2', `Pierd GPS pe ${list} deodată, în ${affected[0].sector.name}. Pare bruiaj mobil, nu defect de dronă.`);
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
        this.sayLater(1, 'OPERATOR_2', `D${d.id} e din nou pe legătură. Păstrează acțiunea de failsafe până decidem.`);
        if (!this.scripted && d.mode === 'LOITER') this.recommendFor(d.id, 'COMMAND_LINK_RESTORED');
      }
    }
  }

  /** A loitering drone steps out of the patrol orbit's path (core/patrol.ts), at patrol speed. */
  private holdOffOrbit(d: SimDrone, dt: number): void {
    if (d.holdPoint === undefined) {
      // Hazards the drone is already inside don't count: it is leaving them anyway.
      const zones = hazardZones(this.zones).filter(z => distanceM(d.lat, d.lon, z.center![0], z.center![1]) > z.radius_m!);
      const clear = (lat: number, lon: number) =>
        !zones.some(z => segmentIntersectsCircle(d.lat, d.lon, lat, lon, z.center![0], z.center![1], z.radius_m!));
      d.holdPoint = holdPoint(d.lat, d.lon, d.sector, clear);
      if (d.holdPoint === null && isOnOrbit(d.lat, d.lon, d.sector)) d.altitude = CRUISE_ALT_M + HOLD_CLIMB_M;
    }
    if (!d.holdPoint || dt === 0) {
      d.repositioning = false;
      return;
    }
    const [tLat, tLon] = d.holdPoint;
    const dist = distanceM(d.lat, d.lon, tLat, tLon);
    const budget = (EGRESS_SPEED_MS / 2) * dt; // patrol speed: no reason to rush
    if (dist <= budget) {
      d.lat = tLat;
      d.lon = tLon;
      d.repositioning = false;
    } else {
      d.lat += ((tLat - d.lat) * budget) / dist;
      d.lon += ((tLon - d.lon) * budget) / dist;
      d.repositioning = true;
    }
  }

  /** Keeps each sector's orbit evenly spaced; logs when a drone joins or leaves it. */
  private coordinatePatrol(): void {
    const members = new Map<string, Set<number>>();
    const sectorsByName = new Map<string, Sector>();
    for (const s of Object.values(SECTORS)) {
      sectorsByName.set(s.name, s);
    }
    for (const d of this.drones) {
      if (d.sector && !sectorsByName.has(d.sector.name)) {
        sectorsByName.set(d.sector.name, d.sector);
      }
    }
    for (const [sName, sector] of sectorsByName) {
      const onOrbit = this.drones.filter(d => d.sector?.name === sName && d.mode === 'PATROL' && d.onOrbit);
      const rates = spacingRates(new Map(onOrbit.map(d => [d.id, d.angle])), ANGULAR_SPEED);
      for (const d of onOrbit) d.patrolRate = rates.get(d.id) ?? ANGULAR_SPEED;
      members.set(sName, new Set(onOrbit.map(d => d.id)));
    }
    const previous = this.patrolMembers;
    this.patrolMembers = members;
    for (const [sector, now] of members) {
      const before = previous.get(sector) ?? new Set<number>();
      const joined = [...now].filter(i => !before.has(i)).sort((a, b) => a - b);
      const left = [...before].filter(i => !now.has(i)).sort((a, b) => a - b);
      if (!joined.length && !left.length) continue;
      const single = joined.length + left.length === 1; // then the log row already names the drone
      const change = single
        ? `${joined.length ? 'Joined' : 'Left'} the ${sector} orbit`
        : [...joined.map(i => `Drone ${i} joined`), ...left.map(i => `Drone ${i} left`)].join(', ') + ` (${sector})`;
      const n = now.size;
      this.log('PATROL_REBALANCED', single ? (joined[0] ?? left[0]) : null, {
        description: `${change}: ${n} drone(s) on patrol` + (n >= 2 ? `, re-spacing to ${Math.round(360 / n)} deg apart` : ''),
        sector, joined, left, patrol_drones: [...now].sort((a, b) => a - b),
      }, 'ORION_PATROL');
    }
  }

  private linkDown(d: SimDrone): boolean {
    return d.linkLostAt !== null;
  }

  private move(d: SimDrone, dt: number): void {
    if (d.mode !== 'LOITER') {
      d.holdPoint = undefined;
      d.repositioning = false;
    }
    if (d.mode === 'PATROL') {
      d.altitude = CRUISE_ALT_M;
      const { center, orbit } = d.sector;
      const targetLat = center.lat + orbit.lat * Math.sin(d.angle);
      const targetLon = center.lon + orbit.lon * Math.cos(d.angle);
      const dist = distanceM(d.lat, d.lon, targetLat, targetLon);
      const budget = EGRESS_SPEED_MS * dt;
      if (dt > 0 && dist > budget * 1.5) {
        d.onOrbit = false;
        const f = budget / dist;
        d.lat += (targetLat - d.lat) * f;
        d.lon += (targetLon - d.lon) * f;
      } else {
        d.onOrbit = true;
        d.angle += d.patrolRate * dt;
        d.lat = center.lat + orbit.lat * Math.sin(d.angle);
        d.lon = center.lon + orbit.lon * Math.cos(d.angle);
      }
      return;
    }
    if (d.mode === 'LOITER') {
      if (d.egressPath.length && this.elapsed >= d.loiterUntil) {
        d.mode = 'EGRESS';
        return;
      }
      this.holdOffOrbit(d, dt);
      return;
    }
    if (d.mode === 'EGRESS' && d.route === 'ROUTE' && this.routeLegBlocked(d)) {
      // A zone moved onto the planned route: re-plan from here, or hold if nothing is safe.
      const off = d.spoofedAt !== null ? SPOOF_OFFSET : { lat: 0, lon: 0 };
      const curLat = d.lat + off.lat;
      const curLon = d.lon + off.lon;
      let replanned: [number, number][] = [];
      const pathType = d.pathType ?? 'SAFE';

      if (d.targetMode === 'PATROL') {
        const pz = this.zones.find(z => z.id === d.patrol_zone_id && z.is_active && z.zone_type === 'PATROL');
        if (pz && pz.center) {
          const route = planTargetRoute([curLat, curLon], [pz.center[0], pz.center[1]], this.zones, pathType);
          if (route && route.waypoints.length > 1) {
            replanned = route.waypoints.map(([la, lo]) => [lo, la] as [number, number]);
          }
        }
      } else if (d.targetMode === 'LOITER' && d.targetPoint) {
        const route = planTargetRoute([curLat, curLon], d.targetPoint, this.zones, pathType);
        if (route && route.waypoints.length > 1) {
          replanned = route.waypoints.map(([la, lo]) => [lo, la] as [number, number]);
        }
      } else {
        const state = this.states().find(s => s.drone_id === d.id)!;
        replanned = egressPaths(state, this.zones).viaRoute;
      }

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
        const targetMode = d.targetMode;
        if (targetMode === 'PATROL') {
          d.mode = 'PATROL';
          d.targetMode = undefined;
          d.egressPath = [];
          d.egressLeg = 0;
          d.spoofedAt = null;
          d.jammedAt = null;
          d.onOrbit = false;
          const pz = this.zones.find(z => z.id === d.patrol_zone_id && z.is_active && z.zone_type === 'PATROL');
          if (pz && pz.center) {
            const [cLat, cLon] = pz.center;
            const rM = pz.radius_m || 350;
            const cosLat = Math.cos((cLat * Math.PI) / 180);
            d.sector = {
              name: pz.name,
              center: { lat: cLat, lon: cLon },
              orbit: {
                lat: (rM / 111139.0) * 0.9,
                lon: (rM / (111139.0 * (cosLat || 1))) * 0.9,
              },
            };
            d.angle = Math.atan2((d.lat - cLat) / d.sector.orbit.lat, (d.lon - cLon) / d.sector.orbit.lon);
          }
          this.log('DRONE_JOINED_PATROL', d.id, {
            zone_id: d.patrol_zone_id,
            zone_name: pz?.name ?? 'Patrol Zone',
            path_type: d.pathType ?? 'SAFE',
            mission_time_s: this.elapsed,
          });
        } else if (targetMode === 'LOITER') {
          d.mode = 'LOITER';
          d.loiterUntil = Infinity;
          d.holdPoint = d.targetPoint ?? [d.lat, d.lon];
          d.targetMode = undefined;
          d.egressPath = [];
          d.egressLeg = 0;
          this.log('DRONE_LOITER_HOLD', d.id, {
            location: d.holdPoint,
            path_type: d.pathType ?? 'SAFE',
            mission_time_s: this.elapsed,
          });
        } else {
          this.log('DRONE_RECOVERED', d.id, {
            location: 'Base Forward Alpha',
            description: `Drone ${d.id} completed retreat to Base Forward zone and was recovered (disappeared).`,
            via: d.route === 'RTL' ? 'Direct return-to-home' : d.route === 'ROUTE' ? 'Computed safe route (A*)' : 'Safe Corridor Alpha',
          });
          this.drones = this.drones.filter(item => item.id !== d.id);
          this.recs = this.recs.filter(r => r.drone_id !== d.id);
        }
      }
    }
  }

  /** True when the leg being flown now crosses a hazard the drone isn't already inside. */
  private routeLegBlocked(d: SimDrone): boolean {
    const target = d.egressPath[d.egressLeg + 1];
    if (!target) return false;
    const off = d.spoofedAt !== null ? SPOOF_OFFSET : { lat: 0, lon: 0 };
    const lat = d.lat + off.lat, lon = d.lon + off.lon;
    const pathType = d.pathType ?? 'SAFE';
    const checkZones = pathType === 'RISKY'
      ? this.zones.filter(z => z.is_active && z.zone_type === 'THREAT' && z.center && z.radius_m)
      : hazardZones(this.zones);
    return checkZones.some(z =>
      distanceM(lat, lon, z.center![0], z.center![1]) > z.radius_m! &&
      segmentIntersectsCircle(lat, lon, target[1], target[0], z.center![0], z.center![1], z.radius_m!));
  }

  private states(): DroneState[] {
    const ts = new Date().toISOString();
    // Drone-to-drone mesh: neighbours range each other by radio and vote on whose GPS is lying.
    // Radio noise is deterministic here so the Demo plays out the same every time.
    const meshView = computeMesh(
      this.drones.map(d => {
        const off = d.spoofedAt !== null ? SPOOF_OFFSET : { lat: 0, lon: 0 };
        return {
          droneId: d.id,
          truePos: [d.lat, d.lon] as [number, number],
          reportedPos: [d.lat + off.lat, d.lon + off.lon] as [number, number],
          online: d.mode !== 'LANDED' && !this.linkDown(d),
        };
      }),
      distanceM,
      (a, b) => 5 * Math.sin(a * 31 + b * 17 + this.elapsed * 3.1),
    );
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
        reasons.push('Impossible position jump (≈560 m in 0.5 s)');
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
      const mv = meshView.get(d.id);
      if (mv && mv.score !== null) {
        // Peers measured their range to this drone by radio: that beats comparing GPS positions.
        consensus = mv.score;
        const why = describeMesh(mv);
        if (why) reasons.push(why);
      } else if (spoofed) {
        reasons.push('Neighbor consensus mismatch (diverged from patrol formation)');
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
        drone_id: d.id, latitude: lat, longitude: lon, altitude: d.mode === 'LANDED' ? 0 : d.altitude,
        ground_speed: d.mode === 'PATROL' || d.repositioning ? 12 : d.mode === 'EGRESS' ? EGRESS_SPEED_MS : 0,
        heading: ((d.angle * 180) / Math.PI + 90) % 360,
        fix_type: fix, satellites_visible: sats, eph,
        battery_remaining: Math.round(Math.max(20, 100 - d.batteryUsed) * 10) / 10,
        drop_rate_comm: drop, rssi, flight_mode: flightMode, is_armed: d.mode !== 'LANDED',
        patrol_zone_id: d.patrol_zone_id ?? (d.sector === SECTORS.B ? 100 : 10),
        trust_score: score, trust_status: status, uncertainty_radius_m: unc, reason,
        scores: {
          drone_id: d.id, trust_score: score, trust_status: status, gps_score: gps, imu_score: imu,
          link_score: link, consensus_score: consensus, command_score: 100, uncertainty_radius_m: unc, reason,
        },
        mesh: mv ?? null,
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
    const withTime = { mission_time_s: this.elapsed, ...details };
    this.ledger.append(type, droneId, withTime, operator).then(() => this.cb.onLedger());
  }

  private drone(id: number): SimDrone {
    return this.drones.find(d => d.id === id)!;
  }
}
