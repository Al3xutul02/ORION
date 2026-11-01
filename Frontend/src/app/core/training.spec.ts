import { AuditEvent, Recommendation } from './models';
import { OfflineSimulator } from './offline-simulator';
import { AdversaryOptions, decisionsFromLog, localAdversary, localDebrief, scoreSession, seededRandom } from './training';

let nextId = 1;
const ev = (event_type: string, drone_id: number | null, details: Record<string, unknown>): AuditEvent => ({
  id: nextId++, timestamp: '2026-10-31T12:00:00Z', event_type, drone_id, details: JSON.stringify(details),
  operator_id: 'TEST', prev_hash: '', curr_hash: '',
});

describe('training score', () => {
  const log = [
    ev('RECOMMENDATION_ISSUED', 2, { recommendation_id: 1, recommended_action: 'SAFE_CORRIDOR_RETREAT', mission_time_s: 10 }),
    ev('RECOMMENDATION_ISSUED', 4, { recommendation_id: 2, recommended_action: 'LOITER', mission_time_s: 20 }),
    ev('OPERATOR_APPROVAL', 4, { recommendation_id: 2, mission_time_s: 26 }),
    ev('OPERATOR_APPROVAL', 2, { recommendation_id: 1, mission_time_s: 50 }),
    ev('RECOMMENDATION_ISSUED', 5, { recommendation_id: 3, recommended_action: 'CONTINUE_PATROL', mission_time_s: 60 }),
    ev('RECOMMENDATION_SUPERSEDED', 5, { recommendation_id: 3, mission_time_s: 70 }),
    ev('RECOMMENDATION_ISSUED', 1, { recommendation_id: 4, recommended_action: 'LOITER', mission_time_s: 100 }),
    ev('RECOMMENDATION_ISSUED', 3, { recommendation_id: 5, recommended_action: 'LOITER', mission_time_s: 175 }),
  ];

  it('measures each decision from the log', () => {
    const ds = decisionsFromLog(log, 0, 180);
    expect(ds.map(d => [d.droneId, d.reactionS, d.outcome])).toEqual([
      [2, 40, 'APPROVED'], [4, 6, 'APPROVED'], [5, 10, 'OVERRIDDEN'], [1, null, 'MISSED'],
    ]); // D3's came 5 s before the end: not counted as missed yet
  });

  it('ignores decisions from before the session started', () => {
    expect(decisionsFromLog(log, 15, 180).map(d => d.droneId)).toEqual([4, 5, 1]);
  });

  it('deducts for slow and missed decisions and red time, and says why', () => {
    const { score, grade, lines } = scoreSession(decisionsFromLog(log, 0, 180), { 2: 45, 4: 15 }, 1, 180);
    // 40 s: -15 (30 s over the 10 s target, capped) · missed: -15 · 60 s red: -12 · one weather breach: -5
    expect(lines.map(l => l.points)).toEqual([-15, -15, -12, -5]);
    expect(score).toBe(53);
    expect(grade).toBe('Satisfăcător');
    expect(lines[0].label).toContain('40 s');
  });

  it('writes the local debrief with the measured numbers', () => {
    const ds = decisionsFromLog(log, 0, 180);
    const text = localDebrief(ds, { 2: 45 }, 55, 'Satisfăcător');
    expect(text.improvements[0]).toBe('Ai aprobat retragerea pe coridor pentru D2 în 40 s; ținta este sub 10 s.');
    expect(text.improvements.some(s => s.includes('D1') && s.includes('fără decizie'))).toBeTrue();
    expect(text.strengths[0]).toContain('cea mai rapidă: loiter pentru D4 în 6 s');
    expect(text.summary).toContain('Scor 55/100');
  });
});

describe('local adversary', () => {
  const options: AdversaryOptions = { available: ['REPLAY', 'SPOOF', 'LINK_LOSS', 'JAMMER', 'STORM'], eligible: { SPOOF: [1, 3], LINK_LOSS: [1, 3, 5] } };

  it('piles on while a decision is pending', () => {
    const m = localAdversary(options, [{ droneId: 2, waitingS: 20 }], [], null, seededRandom(1));
    expect(m.move).toBe('SPOOF');
    expect([1, 3]).toContain(m.target_drone!);
    expect(m.reason).toContain('20 s');
  });

  it('tries attacks the operator has not faced yet, with a valid target', () => {
    const history = [{ move: 'SPOOF', target_drone: 1, wait_s: 20, reason: '', source: 'LOCAL' }, { move: 'REPLAY', target_drone: null, wait_s: 20, reason: '', source: 'LOCAL' }] as const;
    for (let seed = 0; seed < 20; seed++) {
      const m = localAdversary(options, [], [...history], 12, seededRandom(seed));
      expect(['LINK_LOSS', 'JAMMER', 'STORM']).toContain(m.move);
      if (m.move === 'LINK_LOSS') expect(options.eligible.LINK_LOSS).toContain(m.target_drone!);
      expect(m.wait_s).toBeGreaterThanOrEqual(12);
    }
  });

  it('waits when there is nothing to do', () => {
    expect(localAdversary({ available: [], eligible: { SPOOF: [], LINK_LOSS: [] } }, [], [], null, seededRandom(3)).move).toBe('WAIT');
  });
});

describe('Demo simulator in training mode', () => {
  let recs: Recommendation[] = [];
  const make = () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: r => (recs = r) });
    sim.scripted = false;
    return sim;
  };

  it('drops the fixed script', async () => {
    const sim = make();
    for (let i = 0; i < 80; i++) sim.advance(0.5); // 40 s: the script would have spoofed D2 at 30 s
    await sim.ledger.append('TEST_FLUSH', null, {});
    expect(sim.ledger.events.some(e => e.event_type === 'SPOOFING_ATTACK_INITIATED')).toBeFalse();
  });

  it('stages a targeted spoof and puts a decision to the operator once detected', async () => {
    const sim = make();
    expect(sim.adversaryOptions().eligible.SPOOF).toContain(3);
    expect(sim.applyAdversaryMove('SPOOF', 3)).toBeTrue();
    expect(sim.adversaryOptions().eligible.SPOOF).not.toContain(3); // can't spoof it twice
    expect(sim.applyAdversaryMove('SPOOF', 3)).toBeFalse();
    sim.advance(1);
    expect(recs.filter(r => r.status === 'PENDING').length).toBe(0); // not detected yet
    for (let i = 0; i < 6; i++) sim.advance(0.5);
    const rec = recs.find(r => r.drone_id === 3 && r.status === 'PENDING')!;
    expect(rec).toBeDefined();
    for (let i = 0; i < 10; i++) sim.advance(0.5);
    sim.decide(rec.id, 'APPROVE', 'OPERATOR_1');
    await sim.ledger.append('TEST_FLUSH', null, {});
    const [d] = decisionsFromLog(sim.ledger.events, 0, sim.elapsed);
    expect(d.droneId).toBe(3);
    expect(d.reactionS).toBe(6); // detected at T+3 s (DETECTION_DELAY_S), approved at T+9 s
    expect(sim.ledger.events.find(e => e.event_type === 'SPOOFING_ATTACK_INITIATED')!.operator_id).toBe('AI_ADVERSARY');
  });

  it('can bring the jammer back once it has finished its run, and offers weather only once per kind', () => {
    const sim = make();
    expect(sim.applyAdversaryMove('JAMMER', null)).toBeTrue();
    expect(sim.adversaryOptions().available).not.toContain('JAMMER');
    expect(sim.applyAdversaryMove('STORM', null)).toBeTrue();
    expect(sim.adversaryOptions().available).not.toContain('STORM');
    for (let i = 0; i < 200; i++) sim.advance(0.5);
    expect(sim.adversaryOptions().available).toContain('JAMMER');
  });
});

describe('training pressure cap', () => {
  it('never lets more than two drones be spoofed at once', () => {
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
    sim.scripted = false;
    expect(sim.applyAdversaryMove('SPOOF', 1)).toBeTrue();
    expect(sim.applyAdversaryMove('SPOOF', 2)).toBeTrue();
    expect(sim.adversaryOptions().eligible.SPOOF).toEqual([]);
    expect(sim.adversaryOptions().available).not.toContain('SPOOF');
    expect(sim.applyAdversaryMove('SPOOF', 3)).toBeFalse();
  });
});
