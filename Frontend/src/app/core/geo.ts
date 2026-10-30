import { ORION_CONFIG } from './config';
import { DroneState, Zone } from './models';

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
  id: 'RETURN_TO_HOME' | 'LOITER' | 'SAFE_CORRIDOR_RETREAT' | 'CONTINUE_PATROL';
  label: string;
  allowed: boolean;
  recommended: boolean;
  reason: string;
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
  const corridor = zones.find(z => z.zone_type === 'SAFE_CORRIDOR' && z.is_active);
  const degraded = drone.trust_status !== 'GREEN';
  const insideHazard = zoneContaining(zones, drone.latitude, drone.longitude);

  const rtlAllowed = !blocking;
  return [
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
      allowed: !!corridor,
      recommended: degraded && !rtlAllowed && !!corridor,
      reason: corridor ? 'Egress route avoids known hazard zones' : 'No safe corridor defined',
    },
    {
      id: 'CONTINUE_PATROL',
      label: 'Continue patrol',
      allowed: drone.trust_status === 'GREEN',
      recommended: false,
      reason: drone.trust_status === 'GREEN' ? 'Drone is trusted' : 'Position not trusted, mission would run in the wrong place',
    },
  ];
}

/** Direct base path + corridor egress path, as [lon, lat] lines for the map overlay. */
export function egressPaths(drone: DroneState, zones: Zone[]) {
  const base = ORION_CONFIG.homeBase;
  const direct: [number, number][] = [[drone.longitude, drone.latitude], [base.lon, base.lat]];
  const corridor = zones.find(z => z.zone_type === 'SAFE_CORRIDOR' && z.is_active && z.waypoints?.length);
  let viaCorridor: [number, number][] = [];
  if (corridor?.waypoints) {
    // Join the corridor at its far end (the end away from base) and follow it home.
    const wps = [...corridor.waypoints].reverse();
    viaCorridor = [[drone.longitude, drone.latitude], ...wps.map(([la, lo]) => [lo, la] as [number, number])];
  }
  return { direct, viaCorridor };
}
