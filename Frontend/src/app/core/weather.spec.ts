import { evaluateActions, segmentIntersectsCircle, weatherPolygon } from './geo';
import { DroneState, WeatherKind, Zone } from './models';
import { OfflineSimulator } from './offline-simulator';
import { planRoute } from './pathfinding';
import { WEATHER_TEMPLATES, isSevereWeather } from './platform';

// Mirrors Backend/tests/test_weather.py.
const START: [number, number] = [44.34, 23.84];
const ON_THE_LINE: [number, number] = [44.328, 23.82];

const wx = (kind: WeatherKind, center: [number, number] = ON_THE_LINE, radius = 600): Zone => ({
  id: 900, ...WEATHER_TEMPLATES[kind], radius_m: radius, zone_type: 'WEATHER', geometry_type: 'CIRCLE',
  center, is_active: true, detected_by: 'TEST', weather: kind,
});

const drone = (over: Partial<DroneState> = {}): DroneState => ({
  drone_id: 3, latitude: START[0], longitude: START[1], altitude: 120, ground_speed: 12, heading: 0, fix_type: 3,
  satellites_visible: 12, eph: 1, battery_remaining: 90, drop_rate_comm: 0.5, rssi: 95, flight_mode: 'GUIDED',
  is_armed: true, trust_score: 95, trust_status: 'GREEN', uncertainty_radius_m: 0, reason: '', last_updated: '', ...over,
});

describe('weather rules', () => {
  it('treats a storm beyond the wind limit like a hazard on the way home', () => {
    expect(isSevereWeather(wx('STORM'))).toBeTrue();
    const rtl = evaluateActions(drone({ trust_status: 'RED', trust_score: 30 }), [wx('STORM')]).find(a => a.id === 'RETURN_TO_HOME')!;
    expect(rtl.allowed).toBeFalse();
    expect(rtl.reason).toContain('Storm cell');
    expect(rtl.reason).toContain('above the 12 m/s limit');
  });

  it('lets rain within limits stay on the direct path', () => {
    expect(isSevereWeather(wx('RAIN'))).toBeFalse();
    const rtl = evaluateActions(drone(), [wx('RAIN')]).find(a => a.id === 'RETURN_TO_HOME')!;
    expect(rtl.allowed).toBeTrue();
  });

  it('gets a trusted drone caught in a storm out: no patrol, no loitering, RTL recommended', () => {
    const actions = evaluateActions(drone(), [wx('STORM', START, 500)]);
    const by = (id: string) => actions.find(a => a.id === id)!;
    expect(by('CONTINUE_PATROL').allowed).toBeFalse();
    expect(by('LOITER').recommended).toBeFalse();
    expect(by('RETURN_TO_HOME').allowed).toBeTrue(); // the storm it's in isn't in the way home
    expect(by('RETURN_TO_HOME').recommended).toBeTrue();
  });

  it('routes around a small rain cell when cheap, but never treats rain as a wall', () => {
    const goal: [number, number] = [44.316, 23.8];
    const small = { lat: ON_THE_LINE[0], lon: ON_THE_LINE[1], radiusM: 300, name: 'Rain', soft: true };
    const route = planRoute(START, goal, [small])!;
    expect(route.waypoints.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < route.waypoints.length; i++) {
      expect(segmentIntersectsCircle(...route.waypoints[i - 1], ...route.waypoints[i], small.lat, small.lon, small.radiusM)).toBeFalse();
    }
    expect(planRoute(START, goal, [{ lat: goal[0], lon: goal[1], radiusM: 3000, name: 'Rain', soft: true }])).not.toBeNull();
  });
});

describe('weather in the Demo simulator', () => {
  it('drifts a storm across Sector 7, alerts the drones it catches and drains their batteries faster', async () => {
    const recs: number[] = [];
    let last: DroneState[] = [];
    const sim = new OfflineSimulator({
      onFleet: u => (last = u.drones),
      onLedger: () => {},
      onRecommendations: r => recs.splice(0, recs.length, ...r.filter(x => x.status === 'PENDING').map(x => x.drone_id)),
    });
    sim.triggerWeather('STORM');
    for (let t = 0; t < 25; t += 0.5) sim.advance(0.5);
    await sim.ledger.append('TEST_FLUSH', null, {});
    const types = sim.ledger.events.map(e => e.event_type);
    expect(types).toContain('WEATHER_CELL_DETECTED');
    expect(types).toContain('WEATHER_LIMIT_EXCEEDED');
    const alerted = sim.ledger.events.filter(e => e.event_type === 'WEATHER_LIMIT_EXCEEDED').map(e => e.drone_id!);
    expect(alerted.every(id => id === 5 || id === 6)).toBeTrue(); // only Sector 7 is under the storm
    expect(recs.length).toBeGreaterThan(0);
    const battery = (id: number) => last.find(d => d.drone_id === id)!.battery_remaining;
    expect(battery(alerted[0])).toBeLessThan(battery(1));
    expect(last.find(d => d.drone_id === alerted[0])!.reason).toContain('weather, not EW');
  });
});

describe('weatherPolygon geometry', () => {
  it('generates closed realistic polygon rings for STORM, RAIN and WIND', () => {
    for (const kind of ['STORM', 'RAIN', 'WIND'] as const) {
      const ring = weatherPolygon(44.33, 23.83, 600, kind, 42);
      expect(ring.length).toBeGreaterThan(60);
      // Ring must be closed (first vertex == last vertex)
      const first = ring[0];
      const last = ring[ring.length - 1];
      expect(first[0]).toBeCloseTo(last[0], 6);
      expect(first[1]).toBeCloseTo(last[1], 6);
      // Vertices must not collapse to center
      for (const [lon, lat] of ring) {
        expect(Number.isFinite(lon)).toBeTrue();
        expect(Number.isFinite(lat)).toBeTrue();
        expect(Math.hypot(lat - 44.33, lon - 23.83)).toBeGreaterThan(0.001);
      }
    }
  });
});
