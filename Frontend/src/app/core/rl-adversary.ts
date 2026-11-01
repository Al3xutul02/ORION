import { AdversaryMove, AdversaryMoveKind, AdversaryOptions } from './training';
import { Recommendation } from './models';

/**
 * Reinforcement-learning adversary for AI training (Demo). A tabular Q-learning policy, trained
 * offline against the Demo simulator and a virtual operator (scripts/train-adversary.ts), picks
 * the next simulated attack from a small view of the exercise. The reward is drone-seconds in
 * red, weighted towards GPS attacks (spoofing, jamming): those are the ones where the operator
 * has to react fastest, so that's what the training should drill.
 */

export const RL_MOVES: AdversaryMoveKind[] = ['SPOOF', 'JAMMER', 'LINK_LOSS', 'REPLAY', 'STORM', 'WIND', 'RAIN', 'WAIT'];
export const GPS_MOVES: ReadonlySet<AdversaryMoveKind> = new Set(['SPOOF', 'JAMMER']);

/** What the adversary sees: the same few things in training and in the app. */
export interface RlObservation {
  /** Decisions the operator hasn't taken yet. */
  pending: number;
  /** Drones in red right now. */
  red: number;
  /** The mobile jammer is still crossing the theatre. */
  jammerActive: boolean;
  /** Seconds into the session. */
  t: number;
  lastMove: AdversaryMoveKind | null;
}

const LAST = (m: AdversaryMoveKind | null) => (m === null ? 0 : GPS_MOVES.has(m) ? 1 : m === 'LINK_LOSS' || m === 'REPLAY' ? 2 : 3);
export const STATE_COUNT = 3 * 3 * 2 * 3 * 4;

export function encodeState(o: RlObservation): number {
  const pending = Math.min(o.pending, 2);
  const red = Math.min(o.red, 2);
  const phase = o.t < 60 ? 0 : o.t < 120 ? 1 : 2;
  return (((pending * 3 + red) * 2 + (o.jammerActive ? 1 : 0)) * 3 + phase) * 4 + LAST(o.lastMove);
}

export interface RlPolicy {
  version: number;
  trained_at: string;
  episodes: number;
  /** q[state][move index in RL_MOVES]. */
  q: number[][];
  /** Evaluation against the virtual operator, for the debrief and the README. */
  eval: Record<string, { red_s: number; gps_share: number; reaction_s: number }>;
}

/** The moves possible right now, as indexes into RL_MOVES (WAIT always is). */
export function validMoves(options: AdversaryOptions): number[] {
  return RL_MOVES.map((m, i) => (m === 'WAIT' || options.available.includes(m) ? i : -1)).filter(i => i >= 0);
}

/**
 * The policy's move: best Q among the moves possible now, with a little exploration so no two
 * sessions are the same. Targets: a drone not already under attack, at random.
 */
export function pickRlMove(
  policy: RlPolicy,
  obs: RlObservation,
  options: AdversaryOptions,
  rnd: () => number,
  epsilon = 0.12,
): AdversaryMove {
  const valid = validMoves(options);
  const row = policy.q[encodeState(obs)] ?? [];
  const ranked = [...valid].sort((a, b) => (row[b] ?? 0) - (row[a] ?? 0));
  const explore = rnd() < epsilon;
  const index = explore ? valid[Math.floor(rnd() * valid.length)] : ranked[0];
  const move = RL_MOVES[index];
  const pick = (xs: number[]) => (xs.length ? xs[Math.floor(rnd() * xs.length)] : null);
  const target = move === 'SPOOF' ? pick(options.eligible.SPOOF) : move === 'LINK_LOSS' ? pick(options.eligible.LINK_LOSS) : null;
  const next = ranked.find(i => i !== index);
  return {
    move, target_drone: target, wait_s: 15 + Math.floor(rnd() * 11), source: 'RL',
    reason: explainMove(move, obs, explore, next === undefined ? null : RL_MOVES[next]),
  };
}

function explainMove(move: AdversaryMoveKind, o: RlObservation, explored: boolean, runnerUp: AdversaryMoveKind | null): string {
  const situation =
    `${o.pending} ${o.pending === 1 ? 'decizie' : 'decizii'} în așteptare, ${o.red} ${o.red === 1 ? 'dronă' : 'drone'} pe roșu` +
    (o.jammerActive ? ', bruiajul încă activ' : '');
  if (explored) return `Explorare (politica RL încearcă și altceva, ca sesiunile să difere): ${situation}.`;
  const why = GPS_MOVES.has(move)
    ? 'atacurile GPS țin cel mai mult dronele pe roșu și cer reacția cea mai rapidă'
    : move === 'WAIT'
      ? 'presiunea e deja mare; o pauză lasă deciziile să se adune'
      : 'variază presiunea când atacurile GPS nu sunt posibile';
  return `Politica RL (Q-learning): ${situation}; ${why}` + (runnerUp ? ` (a doua opțiune: ${runnerUp}).` : '.');
}

/**
 * A stand-in for a human operator, used to train and evaluate the adversary: approves each
 * recommendation after a reaction time that grows with the number of pending decisions and is
 * longer for GPS attacks (the position has to be cross-checked), and now and then misses one.
 */
export class VirtualOperator {
  private due = new Map<number, number | null>();

  constructor(private rnd: () => number, private missRate = 0.06) {}

  /** Call with the simulator's recommendations: new pending ones get a reaction time. */
  observe(recs: Recommendation[], now: number): void {
    const pending = recs.filter(r => r.status === 'PENDING');
    for (const r of pending) {
      if (this.due.has(r.id)) continue;
      if (this.rnd() < this.missRate) {
        this.due.set(r.id, null);
        continue;
      }
      const gps = /SPOOF|GPS|JAM/.test(r.trigger_event) ? 3 : 0;
      const delay = 3 + -Math.log(1 - this.rnd() * 0.999) * 6 + 4 * (pending.length - 1) + gps;
      this.due.set(r.id, now + Math.min(delay, 60));
    }
  }

  /** Recommendation ids the operator approves now. */
  act(recs: Recommendation[], now: number): number[] {
    return recs.filter(r => r.status === 'PENDING' && (this.due.get(r.id) ?? Infinity) <= now).map(r => r.id);
  }

  reset(): void {
    this.due.clear();
  }
}
