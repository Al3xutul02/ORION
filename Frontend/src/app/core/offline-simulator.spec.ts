import { verifyChain } from './hash-chain';
import { OfflineSimulator } from './offline-simulator';

describe('OfflineSimulator (extended exercise)', () => {
  async function runExercise(seconds: number) {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    for (let t = 0; t < seconds; t += 0.5) sim.advance(0.5);
    await sim.ledger.append('TEST_FLUSH', null, {}); // appends are queued; wait for all of them
    return sim.ledger.events.map(e => ({ type: e.event_type, drone: e.drone_id, ...JSON.parse(e.details) }));
  }

  it('stages nothing on its own: attacks come from the adversary or the buttons', async () => {
    const events = await runExercise(180);
    const attacks = ['SPOOFING_ATTACK_INITIATED', 'COMMAND_REPLAY_REJECTED', 'EW_EMITTER_ACTIVE', 'COMMAND_LINK_LOST'];
    expect(events.some(e => attacks.includes(e.type))).toBeFalse();
  });

  it('plays a jammer and a link loss through to consensus and the failsafe', async () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    const at = () => sim.ledger.events.map(e => ({ type: e.event_type, ...JSON.parse(e.details) }));
    expect(sim.applyAdversaryMove('JAMMER', null)).toBeTrue();
    for (let t = 0; t < 40; t += 0.5) sim.advance(0.5);
    expect(sim.applyAdversaryMove('LINK_LOSS', 5)).toBeTrue();
    for (let t = 0; t < 20; t += 0.5) sim.advance(0.5);
    await sim.ledger.append('TEST_FLUSH', null, {});
    const events = at();
    const first = (type: string) => events.find(e => e.type === type)?.mission_time_s as number | undefined;
    // Consensus first sees a single-drone fault, then marks the zone.
    expect(first('GPS_DEGRADED_SINGLE')!).toBeLessThan(first('ZONE_INTERFERENCE_MARKED')!);
    expect(first('FAILSAFE_APPLIED')).toBe(45); // 5 s after the link was lost at T+40
    expect(first('COMMAND_LINK_RESTORED')).toBe(55);
  });

  it('keeps the hash chain intact across the whole exercise', async () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    sim.applyAdversaryMove('SPOOF', 2);
    sim.applyAdversaryMove('JAMMER', null);
    for (let t = 0; t < 180; t += 0.5) sim.advance(0.5);
    await sim.ledger.append('TEST_FLUSH', null, {});
    expect((await verifyChain(sim.ledger.events)).is_valid).toBeTrue();
  });

  it('refuses commands to a drone whose link is down', () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    sim.applyAdversaryMove('LINK_LOSS', 5);
    expect(sim.command(5, 'LOITER', 'OPERATOR_1').ok).toBeFalse();
    expect(sim.command(6, 'LOITER', 'OPERATOR_1').ok).toBeTrue();
  });

  it('supports creating and deleting patrol zones and commanding patrol & loiter', () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    const pz = sim.addPatrolZone('Patrol Zone Test', [44.33, 23.82], 400);
    expect(pz.id).toBeGreaterThan(100);
    expect(pz.name).toBe('Patrol Zone Test');

    const cmdPatrol = sim.command(1, 'JOIN_PATROL', 'OPERATOR_1', pz.id, undefined, 'SAFE');
    expect(cmdPatrol.ok).toBeTrue();

    const cmdLoiter = sim.command(2, 'LOITER_AT', 'OPERATOR_1', undefined, [44.32, 23.81], 'RISKY');
    expect(cmdLoiter.ok).toBeTrue();

    const deleted = sim.deleteZone(pz.id);
    expect(deleted).toBeTrue();
  });

  it('navigates drones to patrol zone and loiter point without disappearing', () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    const pz = sim.addPatrolZone('Clear Patrol Zone', [44.355, 23.82], 300);

    const cmdPatrol = sim.command(1, 'JOIN_PATROL', 'OPERATOR_1', pz.id, undefined, 'SAFE');
    expect(cmdPatrol.ok).toBeTrue();

    const d1 = (sim as any).drones.find((d: any) => d.id === 1);
    expect(d1.targetMode).toBe('PATROL');
    expect(d1.mode).toBe('EGRESS');

    const loiterPt: [number, number] = [44.335, 23.82];
    const cmdLoiter = sim.command(3, 'LOITER_AT', 'OPERATOR_1', undefined, loiterPt, 'SAFE');
    expect(cmdLoiter.ok).toBeTrue();

    const d3 = (sim as any).drones.find((d: any) => d.id === 3);
    expect(d3.targetMode).toBe('LOITER');
    expect(d3.mode).toBe('EGRESS');

    for (let t = 0; t < 150; t++) sim.advance(1);

    expect(d1.mode).toBe('PATROL');
    expect((sim as any).drones.some((d: any) => d.id === 1)).toBeTrue();

    expect(d3.mode).toBe('LOITER');
    expect(d3.lat).toBeCloseTo(loiterPt[0], 2);
    expect(d3.lon).toBeCloseTo(loiterPt[1], 2);
    expect((sim as any).drones.some((d: any) => d.id === 3)).toBeTrue();
  });

  it('supports creating and deleting objective zones (polygons and lines)', () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    // Polygon with vertices out of order (cross order)
    const oz = sim.addObjectiveZone('Objective Zone Alpha', [
      [44.31, 23.80],
      [44.32, 23.82],
      [44.31, 23.82],
      [44.32, 23.80],
    ]);
    expect(oz.id).toBeGreaterThan(100);
    expect(oz.name).toBe('Objective Zone Alpha');
    expect(oz.zone_type).toBe('OBJECTIVE');
    expect(oz.geometry_type).toBe('POLYGON');
    expect(oz.waypoints?.length).toBe(4);

    // 2-point line
    const ozLine = sim.addObjectiveZone('Objective Line Bravo', [[44.31, 23.80], [44.32, 23.82]]);
    expect(ozLine.geometry_type).toBe('POLYGON');
    expect(ozLine.waypoints?.length).toBe(2);

    expect(sim.deleteZone(oz.id)).toBeTrue();
    expect(sim.deleteZone(ozLine.id)).toBeTrue();
  });

  it('supports deploying a new drone in base forward zone and disappears on retreat completion', () => {
    let currentFleet: any = null;
    const sim = new OfflineSimulator({
      onFleet: f => { currentFleet = f; },
      onLedger: () => {},
      onRecommendations: () => {},
    });

    const newDrone = sim.deployDrone();
    expect(newDrone.id).toBe(7); // starts with 6 drones in offline fleet
    expect(newDrone.mode).toBe('LOITER');
    expect(newDrone.lat).toBeCloseTo(44.316, 2);
    expect(newDrone.lon).toBeCloseTo(23.8, 2);

    // Command drone 7 to return to home (base)
    const cmd = sim.command(7, 'RETURN_TO_HOME', 'OPERATOR_1');
    expect(cmd.ok).toBeTrue();

    // Advance simulator until retreat finishes and drone reaches Base Forward Alpha (within ~5 seconds)
    for (let t = 0; t < 10; t += 1) {
      sim.advance(1);
    }

    // Drone 7 should have disappeared from fleet
    expect((sim as any).drones.some((d: any) => d.id === 7)).toBeFalse();
  });
});
