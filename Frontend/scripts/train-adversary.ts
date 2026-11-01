/**
 * Trains the AI-training adversary with tabular Q-learning against the Demo simulator and a
 * virtual operator, then writes the policy the app plays (src/app/core/adversary-policy.json).
 *
 *   npm run train:adversary            (default 4000 episodes)
 *   npm run train:adversary -- 8000
 *
 * Reward per adversary turn: drone-seconds in red until the next turn, GPS-caused red counting
 * 1.5x, plus a little for the operator's pending workload and for choosing a GPS attack, so the
 * policy drills the threats the operator must answer fastest.
 */
import { writeFileSync } from 'node:fs';
import { OfflineSimulator } from '../src/app/core/offline-simulator';
import { DroneState, Recommendation } from '../src/app/core/models';
import {
  GPS_MOVES, RL_MOVES, RlObservation, RlPolicy, STATE_COUNT, VirtualOperator, encodeState, pickRlMove, validMoves,
} from '../src/app/core/rl-adversary';
import { AdversaryMove, AdversaryMoveKind, FIRST_MOVE_AT_S, SESSION_LENGTH_S, localAdversary, seededRandom } from '../src/app/core/training';

const EPISODES = Number(process.argv[2]) || 4000;
const EVAL_EPISODES = 200;
const DT = 1;
const ALPHA = 0.1;
const GAMMA = 0.9;
const GPS_RED_WEIGHT = 1.5;
const PENDING_WEIGHT = 0.3;
const GPS_MOVE_BONUS = 4;
const OUT = new URL('../src/app/core/adversary-policy.json', import.meta.url);

type Chooser = (obs: RlObservation, sim: OfflineSimulator, history: AdversaryMove[], rnd: () => number) => { index: number; move: AdversaryMove };

interface EpisodeResult { redS: number; gpsMoves: number; moves: number; reactions: number[] }

let drones: DroneState[] = [];
let recs: Recommendation[] = [];
const sim = new OfflineSimulator({
  onFleet: u => { drones = u.drones; },
  onLedger: () => {},
  onRecommendations: r => { recs = r; },
});

function observe(t: number, last: AdversaryMoveKind | null): RlObservation {
  return {
    pending: recs.filter(r => r.status === 'PENDING').length,
    red: drones.filter(d => d.trust_status === 'RED').length,
    jammerActive: !sim.adversaryOptions().available.includes('JAMMER'),
    t,
    lastMove: last,
  };
}

/** One 3-minute session. `learn` gets (state, action, reward, next state, valid next actions | null at the end). */
function episode(choose: Chooser, seed: number, learn?: (s: number, a: number, r: number, s2: number, valid2: number[] | null) => void): EpisodeResult {
  const rnd = seededRandom(seed);
  sim.reset();
  sim.scripted = false;
  recs = [];
  const operator = new VirtualOperator(rnd);
  const issuedAt = new Map<number, number>();
  const result: EpisodeResult = { redS: 0, gpsMoves: 0, moves: 0, reactions: [] };
  const history: AdversaryMove[] = [];
  let nextMove = FIRST_MOVE_AT_S;
  let pendingTurn: { s: number; a: number; reward: number } | null = null;

  for (let t = 0; t < SESSION_LENGTH_S; t += DT) {
    if (t >= nextMove) {
      const obs = observe(t, history.at(-1)?.move ?? null);
      const s = encodeState(obs);
      if (pendingTurn) learn?.(pendingTurn.s, pendingTurn.a, pendingTurn.reward, s, validMoves(sim.adversaryOptions()));
      const { index, move } = choose(obs, sim, history, rnd);
      sim.applyAdversaryMove(move.move, move.target_drone, 'RL_TRAINING');
      history.push(move);
      result.moves++;
      if (GPS_MOVES.has(move.move)) result.gpsMoves++;
      pendingTurn = { s, a: index, reward: GPS_MOVES.has(move.move) ? GPS_MOVE_BONUS : 0 };
      nextMove = t + move.wait_s;
    }
    sim.advance(DT);
    operator.observe(recs, t);
    for (const r of recs) if (r.status === 'PENDING' && !issuedAt.has(r.id)) issuedAt.set(r.id, t);
    for (const id of operator.act(recs, t)) {
      result.reactions.push(t - (issuedAt.get(id) ?? t));
      sim.decide(id, 'APPROVE', 'VIRTUAL_OPERATOR');
    }
    let red = 0;
    for (const d of drones) {
      if (d.trust_status !== 'RED') continue;
      red += (d.scores?.gps_score ?? 100) <= 40 ? GPS_RED_WEIGHT : 1;
    }
    result.redS += drones.filter(d => d.trust_status === 'RED').length * DT;
    if (pendingTurn) pendingTurn.reward += (red + PENDING_WEIGHT * recs.filter(r => r.status === 'PENDING').length) * DT;
  }
  if (pendingTurn) learn?.(pendingTurn.s, pendingTurn.a, pendingTurn.reward, 0, null);
  return result;
}

const q: number[][] = Array.from({ length: STATE_COUNT }, () => RL_MOVES.map(() => 0));
const policy = (): RlPolicy => ({ version: 1, trained_at: new Date().toISOString(), episodes: EPISODES, q, eval: {} });

function learner(epsilon: () => number): Chooser {
  return (obs, s, _h, rnd) => {
    const move = pickRlMove(policy(), obs, s.adversaryOptions(), rnd, epsilon());
    return { index: RL_MOVES.indexOf(move.move), move };
  };
}

const randomPolicy: Chooser = (_o, s, _h, rnd) => {
  const valid = validMoves(s.adversaryOptions());
  const index = valid[Math.floor(rnd() * valid.length)];
  const opts = s.adversaryOptions();
  const move = RL_MOVES[index];
  const pick = (xs: number[]) => (xs.length ? xs[Math.floor(rnd() * xs.length)] : null);
  return {
    index,
    move: { move, target_drone: move === 'SPOOF' ? pick(opts.eligible.SPOOF) : move === 'LINK_LOSS' ? pick(opts.eligible.LINK_LOSS) : null, wait_s: 15 + Math.floor(rnd() * 11), reason: '', source: 'LOCAL' },
  };
};

const rulesPolicy: Chooser = (obs, s, history, rnd) => {
  const move = localAdversary(s.adversaryOptions(), recs.filter(r => r.status === 'PENDING').map(() => ({ droneId: null, waitingS: 10 })), history, null, rnd);
  return { index: RL_MOVES.indexOf(move.move), move };
};

function evaluate(name: string, choose: Chooser) {
  let red = 0, gps = 0, moves = 0;
  const reactions: number[] = [];
  for (let i = 0; i < EVAL_EPISODES; i++) {
    const r = episode(choose, 1_000_000 + i);
    red += r.redS; gps += r.gpsMoves; moves += r.moves; reactions.push(...r.reactions);
  }
  const out = {
    red_s: Math.round(red / EVAL_EPISODES),
    gps_share: Math.round((gps / Math.max(1, moves)) * 100) / 100,
    reaction_s: Math.round((reactions.reduce((a, b) => a + b, 0) / Math.max(1, reactions.length)) * 10) / 10,
  };
  console.log(`  ${name.padEnd(8)} red drone-seconds/session ${String(out.red_s).padStart(4)} · GPS attacks ${Math.round(out.gps_share * 100)}% · operator reaction ${out.reaction_s} s`);
  return out;
}

const started = Date.now();
let episodeNo = 0;
const eps = () => Math.max(0.05, 1 - episodeNo / (EPISODES * 0.7));
const train = learner(eps);
for (; episodeNo < EPISODES; episodeNo++) {
  episode(train, episodeNo, (s, a, r, s2, valid2) => {
    const best = valid2 ? Math.max(...valid2.map(i => q[s2][i])) : 0;
    q[s][a] += ALPHA * (r / 10 + GAMMA * best - q[s][a]);
  });
  if ((episodeNo + 1) % 500 === 0) console.log(`episode ${episodeNo + 1}/${EPISODES} (${Math.round((Date.now() - started) / 1000)} s)`);
}

console.log(`Evaluation, ${EVAL_EPISODES} sessions each, against the virtual operator:`);
const result = policy();
result.q = q.map(row => row.map(v => Math.round(v * 1000) / 1000));
result.eval = {
  rl: evaluate('RL', learner(() => 0)),
  rules: evaluate('rules', rulesPolicy),
  random: evaluate('random', randomPolicy),
};
writeFileSync(OUT, JSON.stringify(result) + '\n');
console.log(`Policy written to ${OUT.pathname} in ${Math.round((Date.now() - started) / 1000)} s.`);
