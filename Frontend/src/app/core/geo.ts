import { ORION_CONFIG } from './config';
import { DroneState, Zone } from './models';
import { PlannedRoute, planRoute } from './pathfinding';

const M_PER_DEG_LAT = 111139;

export function metersPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  const dx = (lon2 - lon1) * metersPerDegLon((lat1 + lat2) / 2);
  return Math.hypot(dx, dy);
}

/** Polygon ring ([lon, lat][]) approximating a circle, for MapLibre fill layers. */
export function circleRing(lat: number, lon: number, radiusM: number, steps = 64): [number, number][] {
  const ring: [number, number][] = [];
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLon = radiusM / metersPerDegLon(lat);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}

/** Same projected segment/circle test as Backend theatre_rules.line_segment_intersects_circle. */
export function segmentIntersectsCircle(
  lat1: number, lon1: number, lat2: number, lon2: number,
  cLat: number, cLon: number, radiusM: number,
): boolean {
  const mLon = metersPerDegLon(cLat);
  const x1 = (lon1 - cLon) * mLon, y1 = (lat1 - cLat) * M_PER_DEG_LAT;
  const x2 = (lon2 - cLon) * mLon, y2 = (lat2 - cLat) * M_PER_DEG_LAT;
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(x1, y1) <= radiusM;
  const t = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lenSq));
  return Math.hypot(x1 + t * dx, y1 + t * dy) <= radiusM;
}

export function hazardZones(zones: Zone[]): Zone[] {
  return zones.filter(
    z => z.is_active && (z.zone_type === 'INTERFERENCE' || z.zone_type === 'THREAT') && z.center && z.radius_m,
  );
}

export function zoneContaining(zones: Zone[], lat: number, lon: number): Zone | undefined {
  return hazardZones(zones).find(z => distanceM(lat, lon, z.center![0], z.center![1]) <= z.radius_m!);
}

export interface ActionOption {
  id: 'RETURN_TO_HOME' | 'LOITER' | 'SAFE_CORRIDOR_RETREAT' | 'SAFE_ROUTE_RETREAT' | 'CONTINUE_PATROL';
  label: string;
  allowed: boolean;
  recommended: boolean;
  /** The drone is currently executing this action. */
  active: boolean;
  reason: string;
}

const ACTIVE_MODE: Record<ActionOption['id'], string> = {
  RETURN_TO_HOME: 'RTL',
  LOITER: 'LOITER',
  SAFE_CORRIDOR_RETREAT: 'CORRIDOR',
  SAFE_ROUTE_RETREAT: 'ROUTE',
  CONTINUE_PATROL: 'GUIDED',
};

// Planning is cheap but runs on every telemetry tick for the selected drone; reuse recent results.
const routeCache = new Map<string, PlannedRoute | null>();

/** A* route from the drone to Home Base around every active hazard zone (see pathfinding.ts). */
export function safeRoute(drone: DroneState, zones: Zone[]): PlannedRoute | null {
  const hazards = hazardZones(zones).map(z => ({ lat: z.center![0], lon: z.center![1], radiusM: z.radius_m!, name: z.name }));
  const key = [
    drone.latitude.toFixed(4), drone.longitude.toFixed(4),
    ...hazards.map(h => `${h.lat.toFixed(4)},${h.lon.toFixed(4)},${Math.round(h.radiusM)}`),
  ].join('|');
  if (!routeCache.has(key)) {
    if (routeCache.size > 64) routeCache.clear();
    const base = ORION_CONFIG.homeBase;
    routeCache.set(key, planRoute([drone.latitude, drone.longitude], [base.lat, base.lon], hazards));
  }
  return routeCache.get(key)!;
}

export function describeRoute(route: PlannedRoute): string {
  const legs = route.waypoints.length - 1;
  const around = route.avoided.length ? `, around ${route.avoided.join(', ')}` : '';
  return `${legs} leg${legs === 1 ? '' : 's'}, ${(route.lengthM / 1000).toFixed(1)} km${around}`;
}

function corridorRoute(drone: DroneState, corridor: Zone): [number, number][] {
  if (!corridor.waypoints?.length) return [];
  const wps = [...corridor.waypoints].reverse();
  return [[drone.longitude, drone.latitude], ...wps.map(([la, lo]) => [lo, la] as [number, number])];
}

function selectCorridor(drone: DroneState, zones: Zone[]): { corridor?: Zone; route: [number, number][]; blocking?: Zone } {
  const corridors = zones.filter(z => z.zone_type === 'SAFE_CORRIDOR' && z.is_active && z.waypoints?.length);
  if (!corridors.length) return { route: [] };

  const insideHazard = zoneContaining(zones, drone.latitude, drone.longitude);
  const hazards = hazardZones(zones);

  let firstBlocking: Zone | undefined;
  for (const c of corridors) {
    const route = corridorRoute(drone, c);
    const blk = hazards.find(z =>
      z !== insideHazard &&
      route.slice(1).some(([lon, lat], i) => {
        const [pLon, pLat] = route[i];
        return segmentIntersectsCircle(pLat, pLon, lat, lon, z.center![0], z.center![1], z.radius_m!);
      }),
    );
    if (!blk) return { corridor: c, route };
    firstBlocking ??= blk;
  }

  return { corridor: corridors[0], route: corridorRoute(drone, corridors[0]), blocking: firstBlocking };
}

/**
 * "Ce pot face acum în siguranță?" — the per-drone action matrix. Mirrors the backend
 * rule (RTL blocked if the direct path crosses an INTERFERENCE/THREAT zone) and adds the
 * reversible alternatives the spec lists: loiter, safe corridor, continue.
 */
export function evaluateActions(drone: DroneState, zones: Zone[]): ActionOption[] {
  const base = ORION_CONFIG.homeBase;
  const blocking = hazardZones(zones).find(z =>
    segmentIntersectsCircle(drone.latitude, drone.longitude, base.lat, base.lon, z.center![0], z.center![1], z.radius_m!),
  );
  const degraded = drone.trust_status !== 'GREEN';
  const insideHazard = zoneContaining(zones, drone.latitude, drone.longitude);
  const { corridor, blocking: corridorBlocking } = selectCorridor(drone, zones);
  const corridorAllowed = !!corridor && !corridorBlocking;

  const rtlAllowed = !blocking;
  // Only worth planning when the straight line is blocked; otherwise RTL is the route.
  const route = rtlAllowed ? null : safeRoute(drone, zones);
  const options: Omit<ActionOption, 'active'>[] = [
    {
      id: 'RETURN_TO_HOME',
      label: 'Return to home',
      allowed: rtlAllowed,
      recommended: degraded && rtlAllowed,
      reason: blocking ? `Direct path crosses ${blocking.name}` : 'Direct path to base is clear',
    },
    {
      id: 'LOITER',
      label: 'Loiter in place',
      allowed: true,
      recommended: degraded && !rtlAllowed,
      reason: insideHazard ? `Holding inside ${insideHazard.name}, keep short` : 'Reversible, stabilises the drone',
    },
    {
      id: 'SAFE_CORRIDOR_RETREAT',
      label: corridor ? `Retreat via ${corridor.name}` : 'Retreat via safe corridor',
      allowed: corridorAllowed,
      recommended: degraded && !rtlAllowed && corridorAllowed,
      reason: !corridor
        ? 'No safe corridor active in theatre'
        : corridorBlocking
          ? `Route to the corridor crosses ${corridorBlocking.name}`
          : 'Egress route avoids known hazard zones',
    },
    {
      id: 'SAFE_ROUTE_RETREAT',
      label: 'Return via computed safe route',
      allowed: rtlAllowed || !!route,
      recommended: degraded && !rtlAllowed && !corridorAllowed && !!route,
      reason: rtlAllowed
        ? 'Direct path is clear: same as return-to-home'
        : route
          ? `A* route: ${describeRoute(route)}`
          : 'No safe route around the active zones',
    },
    {
      id: 'CONTINUE_PATROL',
      label: 'Continue patrol',
      allowed: drone.trust_status === 'GREEN',
      recommended: false,
      reason: drone.trust_status === 'GREEN' ? 'Drone is trusted' : 'Position not trusted, mission would run in the wrong place',
    },
  ];

  if (!drone.is_armed) {
    return options.map(o => ({ ...o, allowed: false, recommended: false, active: false, reason: 'Drone has landed at base' }));
  }
  const withActive = options.map(o => ({ ...o, active: drone.flight_mode === ACTIVE_MODE[o.id] }));
  const handled = withActive.some(o => o.active && o.allowed && o.id !== 'CONTINUE_PATROL');
  return handled ? withActive.map(o => ({ ...o, recommended: false })) : withActive;
}

/** Direct base path, corridor egress path and computed safe route, as [lon, lat] lines for the map. */
export function egressPaths(drone: DroneState, zones: Zone[]) {
  const base = ORION_CONFIG.homeBase;
  const direct: [number, number][] = [[drone.longitude, drone.latitude], [base.lon, base.lat]];
  const { route: viaCorridor } = selectCorridor(drone, zones);
  const planned = safeRoute(drone, zones);
  const viaRoute: [number, number][] = planned ? planned.waypoints.map(([la, lo]) => [lo, la] as [number, number]) : [];
  return { direct, viaCorridor, viaRoute };
}
