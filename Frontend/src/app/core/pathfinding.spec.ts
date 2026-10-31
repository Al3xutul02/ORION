import { evaluateActions, planTargetRoute, segmentIntersectsCircle } from './geo';
import { DroneState, Zone } from './models';
import { MARGIN_M, planRoute } from './pathfinding';

// Same cases as Backend/tests/test_pathfinder.py, so the two planners stay in step.
const START: [number, number] = [44.34, 23.84];
const GOAL: [number, number] = [44.316, 23.8];
const BLOCKER = { lat: 44.328, lon: 23.82, radiusM: 600, name: 'EW Jamming Zone' };

describe('planRoute (A*)', () => {
  it('goes around a hazard on the direct line, keeping the safety margin', () => {
    expect(segmentIntersectsCircle(...START, ...GOAL, BLOCKER.lat, BLOCKER.lon, BLOCKER.radiusM)).toBeTrue();
    const route = planRoute(START, GOAL, [BLOCKER])!;
    expect(route).not.toBeNull();
    expect(route.waypoints[0]).toEqual(START);
    expect(route.waypoints.at(-1)).toEqual(GOAL);
    expect(route.waypoints.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < route.waypoints.length; i++) {
      const [a, b] = [route.waypoints[i - 1], route.waypoints[i]];
      expect(segmentIntersectsCircle(...a, ...b, BLOCKER.lat, BLOCKER.lon, BLOCKER.radiusM + MARGIN_M * 0.85)).toBeFalse();
    }
    expect(route.avoided).toEqual(['EW Jamming Zone']);
  });

  it('keeps a clear path as one straight leg', () => {
    const route = planRoute(START, GOAL, [{ lat: 44.4, lon: 23.95, radiusM: 300, name: 'Far zone' }])!;
    expect(route.waypoints.length).toBe(2);
  });

  it('finds no route when the drone is surrounded', () => {
    const mLat = 111139, mLon = 111139 * Math.cos((START[0] * Math.PI) / 180);
    const ring = Array.from({ length: 8 }, (_, k) => {
      const a = (k * Math.PI) / 4;
      return { lat: START[0] + (1000 * Math.sin(a)) / mLat, lon: START[1] + (1000 * Math.cos(a)) / mLon, radiusM: 450, name: `Ring ${k}` };
    });
    expect(planRoute(START, GOAL, ring)).toBeNull();
  });

  it('lets a drone inside a zone get out', () => {
    const route = planRoute(START, GOAL, [{ lat: START[0], lon: START[1], radiusM: 500, name: 'Around drone' }, BLOCKER]);
    expect(route).not.toBeNull();
    expect(route!.waypoints.at(-1)).toEqual(GOAL);
  });
});

describe('safe route action', () => {
  const zone = (over: Partial<Zone>): Zone => ({
    id: 1, name: 'EW Jamming Zone', zone_type: 'INTERFERENCE', geometry_type: 'CIRCLE',
    center: [44.325, 23.815], radius_m: 600, is_active: true, detected_by: 'TEST', ...over,
  });
  const drone: DroneState = {
    drone_id: 2, latitude: 44.334, longitude: 23.83, altitude: 120, ground_speed: 12, heading: 0, fix_type: 2,
    satellites_visible: 4, eph: 4.2, battery_remaining: 90, drop_rate_comm: 0.5, rssi: 95, flight_mode: 'GUIDED',
    is_armed: true, trust_score: 30, trust_status: 'RED', uncertainty_radius_m: 120, reason: '', last_updated: '',
  };

  it('is recommended when RTL is blocked and no corridor is open', () => {
    const actions = evaluateActions(drone, [zone({})]);
    expect(actions.find(a => a.id === 'RETURN_TO_HOME')!.allowed).toBeFalse();
    const route = actions.find(a => a.id === 'SAFE_ROUTE_RETREAT')!;
    expect(route.allowed).toBeTrue();
    expect(route.recommended).toBeTrue();
    expect(route.reason).toContain('A* route');
  });

  it('is not needed when the direct path is clear', () => {
    const route = evaluateActions(drone, [zone({ center: [44.36, 23.9], radius_m: 200 })]).find(a => a.id === 'SAFE_ROUTE_RETREAT')!;
    expect(route.recommended).toBeFalse();
    expect(route.reason).toContain('same as return-to-home');
  });
});


describe('planTargetRoute (SAFE vs RISKY)', () => {
  const zones: Zone[] = [
    { id: 1, name: 'Threat Zone Alpha', zone_type: 'THREAT', geometry_type: 'CIRCLE', center: [44.34, 23.84], radius_m: 450, is_active: true, detected_by: 'TEST' },
    { id: 2, name: 'Interference Beta', zone_type: 'INTERFERENCE', geometry_type: 'CIRCLE', center: [44.328, 23.82], radius_m: 500, is_active: true, detected_by: 'TEST' },
  ];
  const start: [number, number] = [44.316, 23.8];
  const goal: [number, number] = [44.335, 23.83];

  it('safe path finds a valid route avoiding all hazards', () => {
    const route = planTargetRoute(start, goal, zones, 'SAFE');
    expect(route).not.toBeNull();
    expect(route!.waypoints.length).toBeGreaterThanOrEqual(2);
  });

  it('risky path allows traversable hazard zones but avoids threat zones', () => {
    const safeRoute = planTargetRoute(start, goal, zones, 'SAFE');
    const riskyRoute = planTargetRoute(start, goal, zones, 'RISKY');
    expect(safeRoute).not.toBeNull();
    expect(riskyRoute).not.toBeNull();
    expect(riskyRoute!.lengthM).toBeLessThanOrEqual(safeRoute!.lengthM + 5);
  });
});
