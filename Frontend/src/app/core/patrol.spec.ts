import { MIN_RATE_FACTOR, TAU, slotErrors, spacingRates } from './patrol';
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
