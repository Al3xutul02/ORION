import { distanceM } from './geo';
import { MeshNode, computeMesh, describeMesh } from './mesh';
import { DroneState } from './models';
import { OfflineSimulator } from './offline-simulator';

// Same cases as Backend/tests/test_mesh.py, so the two implementations stay in step.
const ORIGIN: [number, number] = [44.335, 23.83];
const M_LAT = 111139;
const M_LON = M_LAT * Math.cos((ORIGIN[0] * Math.PI) / 180);
const at = (east: number, north: number): [number, number] => [ORIGIN[0] + north / M_LAT, ORIGIN[1] + east / M_LON];
const FORMATION: Record<number, [number, number]> = { 1: at(330, 0), 2: at(0, 330), 3: at(-330, 0), 4: at(0, -330) };

const honest = (id: number, pos = FORMATION[id]): MeshNode => ({ droneId: id, truePos: pos, reportedPos: pos, online: true });
const spoofed = (id: number, east: number, north: number): MeshNode => {
  const t = FORMATION[id];
  return { droneId: id, truePos: t, reportedPos: [t[0] + north / M_LAT, t[1] + east / M_LON], online: true };
};
const run = (nodes: MeshNode[]) => computeMesh(nodes, distanceM, () => 0);

describe('drone-to-drone mesh', () => {
  it('trusts an honest formation', () => {
    const view = run([1, 2, 3, 4].map(i => honest(i)));
    for (const v of view.values()) {
      expect(v.status).toBe('TRUSTED');
      expect(v.score).toBe(100);
      expect(v.neighbors).toBe(3);
    }
  });

  it('outvotes a spoofed drone without blaming its honest peers', () => {
    const view = run([honest(1), spoofed(2, 400, 300), honest(3), honest(4)]);
    expect(view.get(2)!.status).toBe('OUTLIER');
    expect(view.get(2)!.score).toBe(0);
    for (const i of [1, 3, 4]) expect(view.get(i)!.score).toBe(100);
    expect(describeMesh(view.get(2))).toContain('contradict its GPS position');
  });

  it('catches a small (250 m) spoof too', () => {
    expect(run([honest(1), spoofed(2, 250, 0), honest(3), honest(4)]).get(2)!.status).toBe('OUTLIER');
  });

  it('lets the honest pair win against two liars with different offsets', () => {
    const view = run([honest(1), spoofed(2, 400, 300), honest(3), spoofed(4, -450, -200)]);
    expect([1, 3].map(i => view.get(i)!.status)).toEqual(['TRUSTED', 'TRUSTED']);
    expect([2, 4].map(i => view.get(i)!.status)).toEqual(['OUTLIER', 'OUTLIER']);
  });

  it('marks two lone drones that disagree as disputed', () => {
    const view = run([honest(1), spoofed(2, 400, 300)]);
    expect(view.get(1)!.status).toBe('DISPUTED');
    expect(view.get(2)!.score).toBe(50);
  });

  it('gives no mesh score out of radio range', () => {
    const view = run([honest(1), { droneId: 9, truePos: at(5000, 5000), reportedPos: at(5000, 5000), online: true }]);
    expect(view.get(9)!.score).toBeNull();
  });

  it('cannot see an identical spoof of every drone (known limit)', () => {
    const view = run([1, 2, 3, 4].map(i => spoofed(i, 300, 300)));
    for (const v of view.values()) expect(v.status).toBe('TRUSTED');
  });
});

describe('mesh in the Demo simulator', () => {
  it('outvotes spoofed D2 through its Sector 4 neighbours', () => {
    let last: DroneState[] = [];
    const sim = new OfflineSimulator({ onFleet: u => (last = u.drones), onLedger: () => {}, onRecommendations: () => {} });
    sim.triggerSpoofing();
    sim.advance(0.5);
    const d2 = last.find(d => d.drone_id === 2)!;
    expect(d2.mesh!.status).toBe('OUTLIER');
    expect(d2.scores!.consensus_score).toBe(0);
    expect(d2.reason).toContain('Mesh:');
    expect(last.find(d => d.drone_id === 1)!.mesh!.status).toBe('TRUSTED');
    expect(last.find(d => d.drone_id === 5)!.mesh!.links.every(l => l.peer_id === 6)).toBeTrue(); // Sector 7 is its own island
  });
});
