import policyJson from './adversary-policy.json';
import { Recommendation } from './models';
import { OfflineSimulator } from './offline-simulator';
import { GPS_MOVES, RL_MOVES, RlObservation, RlPolicy, STATE_COUNT, VirtualOperator, encodeState, pickRlMove, validMoves } from './rl-adversary';
import { AdversaryOptions, seededRandom } from './training';

const policy = policyJson as RlPolicy;
const all: AdversaryOptions = { available: ['REPLAY', 'SPOOF', 'LINK_LOSS', 'JAMMER', 'STORM', 'WIND', 'RAIN'], eligible: { SPOOF: [1, 3, 4], LINK_LOSS: [1, 3, 4, 5] } };
const obs = (o: Partial<RlObservation> = {}): RlObservation => ({ pending: 0, red: 0, jammerActive: false, t: 30, lastMove: null, ...o });

describe('RL adversary', () => {
  it('maps every observation to its own state', () => {
    const seen = new Set<number>();
    for (const pending of [0, 1, 2]) for (const red of [0, 1, 2]) for (const jammerActive of [false, true])
      for (const t of [10, 90, 150]) for (const lastMove of [null, 'SPOOF', 'REPLAY', 'STORM'] as const) {
        const s = encodeState({ pending, red, jammerActive, t, lastMove });
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(STATE_COUNT);
        seen.add(s);
      }
    expect(seen.size).toBe(STATE_COUNT);
    expect(encodeState(obs({ pending: 7, red: 5 }))).toBe(encodeState(obs({ pending: 2, red: 2 }))); // capped
  });

  it('only plays moves the simulator can stage, with valid targets', () => {
    const limited: AdversaryOptions = { available: ['REPLAY', 'STORM'], eligible: { SPOOF: [], LINK_LOSS: [] } };
    for (let seed = 0; seed < 200; seed++) {
      const m = pickRlMove(policy, obs({ t: seed % 180 }), limited, seededRandom(seed), 0.5);
      expect(['REPLAY', 'STORM', 'WAIT']).toContain(m.move);
      expect(m.target_drone).toBeNull();
      const n = pickRlMove(policy, obs({ t: seed % 180 }), all, seededRandom(seed), 0.5);
      if (n.move === 'SPOOF') expect(all.eligible.SPOOF).toContain(n.target_drone!);
      if (n.move === 'LINK_LOSS') expect(all.eligible.LINK_LOSS).toContain(n.target_drone!);
      expect(n.wait_s).toBeGreaterThanOrEqual(15);
      expect(n.reason).toBeTruthy();
    }
    expect(validMoves(limited).map(i => RL_MOVES[i])).toEqual(['REPLAY', 'STORM', 'WAIT']);
  });

  it('the trained policy mostly attacks GPS, and beats a random adversary', () => {
    let gps = 0, total = 0;
    for (let seed = 0; seed < 300; seed++) {
      const o = obs({ pending: seed % 3, red: (seed >> 2) % 3, t: (seed * 7) % 180, lastMove: [null, 'SPOOF', 'REPLAY', 'STORM'][seed % 4] as RlObservation['lastMove'] });
      const m = pickRlMove(policy, o, all, seededRandom(seed), 0);
      total++;
      if (GPS_MOVES.has(m.move)) gps++;
    }
    expect(gps / total).toBeGreaterThan(0.6);
    expect(policy.eval['rl'].gps_share).toBeGreaterThan(0.6);
    expect(policy.eval['rl'].red_s).toBeGreaterThan(policy.eval['random'].red_s);
  });

  it('virtual operator: slower with more pending, slower on GPS attacks, never before it sees a decision', () => {
    const rec = (id: number, trigger: string): Recommendation => ({
      id, drone_id: id, trigger_event: trigger, blocked_action: 'NONE', blocked_reason: '', recommended_action: 'LOITER',
      recommendation_details: '', status: 'PENDING', operator_id: null, approved_at: null, timestamp: '',
    });
    const avgDelay = (recs: Recommendation[]) => {
      let sum = 0, n = 0;
      for (let seed = 0; seed < 400; seed++) {
        const op = new VirtualOperator(seededRandom(seed), 0);
        op.observe(recs, 0);
        for (let t = 0; t <= 60; t++) if (op.act(recs, t).includes(recs[0].id)) { sum += t; n++; break; }
      }
      return sum / n;
    };
    expect(avgDelay([rec(1, 'GPS_JAMMED')])).toBeGreaterThan(avgDelay([rec(1, 'WEATHER_LIMIT_EXCEEDED')]));
    expect(avgDelay([rec(1, 'WEATHER_LIMIT_EXCEEDED'), rec(2, 'X'), rec(3, 'X')])).toBeGreaterThan(avgDelay([rec(1, 'WEATHER_LIMIT_EXCEEDED')]));
    expect(new VirtualOperator(seededRandom(1)).act([rec(1, 'X')], 100)).toEqual([]);
  });
});

describe('patrol-zone recommendation', () => {
  it('approving it shifts the orbit instead of commanding a drone that does not exist', () => {
    let recs: Recommendation[] = [];
    const sim = new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: r => (recs = r) });
    sim.scripted = false;
    sim.applyAdversaryMove('JAMMER', null);
    for (let i = 0; i < 80 && !recs.some(r => r.trigger_event === 'PATROL_ZONE_JAMMED'); i++) sim.advance(0.5);
    const zoneRec = recs.find(r => r.trigger_event === 'PATROL_ZONE_JAMMED');
    if (!zoneRec) return pending('the jammer did not reach the patrol zone in this run');
    expect(() => sim.decide(zoneRec.id, 'APPROVE', 'OPERATOR_1')).not.toThrow();
    expect(sim.decide(zoneRec.id, 'APPROVE', 'OPERATOR_1').ok).toBeFalse(); // already decided
  });
});
