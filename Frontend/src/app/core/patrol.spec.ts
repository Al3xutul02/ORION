import { MIN_RATE_FACTOR, TAU, holdPoint, slotErrors, spacingRates } from './patrol';
import { distanceM } from './geo';
import { OfflineSimulator } from './offline-simulator';

// Same cases as Backend/tests/test_patrol.py, so the two implementations stay in step.
const BASE = 0.08;

function fly(angles: Map<number, number>, seconds: number, dt = 0.5): number {
  let slowest = 1;
  for (let t = 0; t < seconds / dt; t++) {
    const rates = spacingRates(angles, BASE);
    for (const [i, r] of rates) {
      expect(r).toBeLessThanOrEqual(BASE); // never faster than the normal orbit
      slowest = Math.min(slowest, r / BASE);
      angles.set(i, angles.get(i)! + r * dt);
    }
  }
  return slowest;
}

function gapsDeg(angles: Map<number, number>): number[] {
  const a = [...angles.values()].map(x => ((x % TAU) + TAU) % TAU).sort((p, q) => p - q);
  return a.map((x, k) => ((((a[(k + 1) % a.length] - x) % TAU) + TAU) % TAU) * (180 / Math.PI));
}

describe('patrol spacing', () => {
  it('leaves an evenly spread patrol alone', () => {
    const angles = new Map([[1, 0], [2, Math.PI / 2], [3, Math.PI], [4, (3 * Math.PI) / 2]]);
    for (const e of slotErrors(angles).values()) expect(Math.abs(e)).toBeLessThan(1e-9);
  });

  it('spreads three drones to 120° after one leaves', () => {
    const angles = new Map([[1, 0], [2, Math.PI / 2], [3, Math.PI]]);
    expect(fly(angles, 45)).toBeGreaterThanOrEqual(MIN_RATE_FACTOR);
    for (const g of gapsDeg(angles)) expect(Math.abs(g - 120)).toBeLessThan(3);
  });

  it('makes room for a drone rejoining next to another', () => {
    const angles = new Map([[1, 0], [2, 0.15], [3, (2 * Math.PI) / 3], [4, (4 * Math.PI) / 3]]);
    fly(angles, 60);
    for (const g of gapsDeg(angles)) expect(Math.abs(g - 90)).toBeLessThan(3);
  });
});

describe('patrol spacing in the Demo simulator', () => {
  it('re-spaces Sector 4 when a drone leaves and logs it', async () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    expect(sim.command(4, 'LOITER', 'TEST').ok).toBeTrue(); // before the first tick, like a paused Demo
    for (let t = 0; t < 90; t++) sim.advance(0.5); // 45 s
    // True orbit angles (D2 gets spoofed at 30 s, which only shifts what it reports).
    const drones = (sim as unknown as { drones: { id: number; angle: number }[] }).drones;
    const angles = new Map(drones.filter(d => d.id <= 3).map(d => [d.id, d.angle]));
    for (const g of gapsDeg(angles)) expect(Math.abs(g - 120)).toBeLessThan(4);
    await sim.ledger.append('TEST_FLUSH', null, {}); // appends are queued; wait for all of them
    const rebalance = sim.ledger.events.filter(e => e.event_type === 'PATROL_REBALANCED');
    expect(rebalance.length).toBe(1);
    expect(rebalance[0].drone_id).toBe(4);
  });
});

describe('holding off the patrol orbit', () => {
  const o = { center: { lat: 44.335, lon: 23.83 }, orbit: { lat: 0.003, lon: 0.004 } };
  const r = ([lat, lon]: [number, number]) => Math.hypot((lat - o.center.lat) / o.orbit.lat, (lon - o.center.lon) / o.orbit.lon);

  it('steps outward, else inward, else nowhere; ignores drones already off the orbit', () => {
    const on: [number, number] = [o.center.lat, o.center.lon + o.orbit.lon];
    expect(r(holdPoint(...on, o, () => true)!)).toBeCloseTo(1.5, 9);
    expect(r(holdPoint(...on, o, (la, lo) => r([la, lo]) < 1)!)).toBeCloseTo(0.5, 9);
    expect(holdPoint(...on, o, () => false)).toBeNull();
    expect(holdPoint(o.center.lat, o.center.lon + 0.2 * o.orbit.lon, o, () => true)).toBeNull();
  });

  it('keeps the patrol from flying through a loitering drone in the Demo', () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    expect(sim.command(4, 'LOITER', 'TEST').ok).toBeTrue();
    const drones = (sim as unknown as { drones: { id: number; lat: number; lon: number; altitude: number }[] }).drones;
    for (let t = 0; t < 30; t++) sim.advance(0.5); // 15 s to step out
    const d4 = drones.find(d => d.id === 4)!;
    expect(r([d4.lat, d4.lon])).toBeCloseTo(1.5, 2);
    expect(d4.altitude).toBe(120);
    let closest = Infinity;
    for (let t = 0; t < 120; t++) {
      sim.advance(0.5);
      for (const d of drones.filter(x => x.id <= 3)) closest = Math.min(closest, distanceM(d.lat, d.lon, d4.lat, d4.lon));
    }
    expect(closest).toBeGreaterThan(120);
  });
});
