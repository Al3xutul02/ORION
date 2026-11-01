import { AuditEvent } from './models';

/**
 * AI operator training (Demo mode). An adversary stages simulated attacks, the operator handles
 * them, and the session is scored from the hash-chained log. The adversary is Gemini on the
 * backend (/training/adversary-move); when that's unavailable, localAdversary() plays instead.
 * Mirrors the move menu in Backend/app/services/training_service.py.
 */

export type AdversaryMoveKind = 'SPOOF' | 'JAMMER' | 'LINK_LOSS' | 'REPLAY' | 'STORM' | 'WIND' | 'RAIN' | 'WAIT';

/** What the simulator can stage right now (OfflineSimulator.adversaryOptions()). */
export interface AdversaryOptions {
  available: AdversaryMoveKind[];
  eligible: { SPOOF: number[]; LINK_LOSS: number[] };
}

export interface AdversaryMove {
  move: AdversaryMoveKind;
  target_drone: number | null;
  wait_s: number;
  /** For the instructor: hidden from the operator until the debrief. */
  reason: string;
  source: 'AI' | 'RL' | 'LOCAL';
  at_s?: number;
}

export interface DecisionRecord {
  recId: number;
  droneId: number | null;
  action: string;
  issuedAt: number;
  reactionS: number | null;
  outcome: 'APPROVED' | 'REJECTED' | 'OVERRIDDEN' | 'MISSED';
}

export interface ScoreLine {
  label: string;
  points: number;
}

export interface TrainingDebrief {
  score: number;
  grade: string;
  lines: ScoreLine[];
  decisions: DecisionRecord[];
  summary: string;
  strengths: string[];
  improvements: string[];
  source: 'AI' | 'LOCAL';
  model?: string;
}

export const SESSION_LENGTH_S = 180;
export const TARGET_REACTION_S = 10;
export const FIRST_MOVE_AT_S = 8;
export const MOVE_LABELS: Record<AdversaryMoveKind, string> = {
  SPOOF: 'GPS spoofing',
  JAMMER: 'Bruiaj mobil',
  LINK_LOSS: 'Pierdere legătură',
  REPLAY: 'Comandă reluată',
  STORM: 'Furtună',
  WIND: 'Vânt puternic',
  RAIN: 'Ploaie',
  WAIT: 'Așteptare',
};

const ACTION_RO: Record<string, string> = {
  LOITER: 'loiter',
  LOITER_THEN_SAFE_CORRIDOR_RETREAT: 'loiter + retragere pe coridor',
  SAFE_CORRIDOR_RETREAT: 'retragerea pe coridor',
  SAFE_ROUTE_RETREAT: 'ruta sigură A*',
  RETURN_TO_HOME: 'întoarcerea la bază',
  CONTINUE_PATROL: 'reluarea patrulei',
  SECTOR_ORBIT_SHIFT: 'mutarea orbitei',
};
export const actionRo = (a: string) => ACTION_RO[a] ?? a.replaceAll('_', ' ').toLowerCase();

function details(e: AuditEvent): Record<string, unknown> {
  try {
    const v = JSON.parse(e.details);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
const missionTime = (e: AuditEvent) => {
  const t = details(e)['mission_time_s'];
  return typeof t === 'number' ? t : 0;
};

/**
 * Every decision ORION put to the operator since `fromS`, with how long the operator took:
 * from RECOMMENDATION_ISSUED to the approval, rejection or a different manual order.
 */
export function decisionsFromLog(events: AuditEvent[], fromS: number, endS: number): DecisionRecord[] {
  const out = new Map<number, DecisionRecord>();
  for (const e of events) {
    const d = details(e);
    const recId = typeof d['recommendation_id'] === 'number' ? (d['recommendation_id'] as number) : null;
    if (recId === null) continue;
    const t = missionTime(e);
    if (e.event_type === 'RECOMMENDATION_ISSUED') {
      if (t < fromS) continue;
      const action = (d['recommended_action'] ?? d['action'] ?? '') as string;
      out.set(recId, { recId, droneId: e.drone_id, action, issuedAt: t, reactionS: null, outcome: 'MISSED' });
      continue;
    }
    const rec = out.get(recId);
    if (!rec || rec.reactionS !== null) continue;
    const outcome = ({
      OPERATOR_APPROVAL: 'APPROVED', OPERATOR_REJECTION: 'REJECTED', RECOMMENDATION_SUPERSEDED: 'OVERRIDDEN',
    } as const)[e.event_type as 'OPERATOR_APPROVAL'];
    if (!outcome) continue;
    rec.outcome = outcome;
    rec.reactionS = Math.round((t - rec.issuedAt) * 10) / 10;
  }
  // A decision raised in the last few seconds isn't "missed" yet.
  return [...out.values()].filter(r => r.reactionS !== null || endS - r.issuedAt >= TARGET_REACTION_S);
}

/** Session score out of 100, with every deduction spelled out. */
export function scoreSession(
  decisions: DecisionRecord[],
  redSeconds: Record<number, number>,
  weatherBreaches: number,
  endS: number,
): { score: number; grade: string; lines: ScoreLine[] } {
  const lines: ScoreLine[] = [];
  for (const d of decisions) {
    const who = d.droneId ? `D${d.droneId}` : 'patrulă';
    if (d.reactionS === null) {
      lines.push({ label: `Decizie ratată: ${actionRo(d.action)} pentru ${who} (${Math.round(endS - d.issuedAt)} s fără răspuns)`, points: -15 });
    } else if (d.reactionS > TARGET_REACTION_S) {
      const pts = -Math.min(15, Math.round((d.reactionS - TARGET_REACTION_S) / 2));
      if (pts < 0) lines.push({ label: `Decizie lentă: ${actionRo(d.action)} pentru ${who} în ${Math.round(d.reactionS)} s`, points: pts });
    }
  }
  const red = Object.values(redSeconds).reduce((a, b) => a + b, 0);
  const redPts = -Math.min(25, Math.floor(red / 5));
  if (redPts < 0) lines.push({ label: `Timp total cu drone pe roșu: ${Math.round(red)} s`, points: redPts });
  if (weatherBreaches) lines.push({ label: `Drone prinse în vreme peste limită: ${weatherBreaches}`, points: -5 * weatherBreaches });
  const score = Math.max(0, Math.min(100, 100 + lines.reduce((a, l) => a + l.points, 0)));
  const grade = score >= 85 ? 'Excelent' : score >= 70 ? 'Bine' : score >= 50 ? 'Satisfăcător' : 'De exersat';
  return { score, grade, lines };
}

/** Mulberry32: a small seeded RNG, so a local session can be replayed in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The adversary when Gemini isn't available. Same idea, simpler rules: pile on while a
 * decision is pending, otherwise try a kind of attack the operator hasn't faced yet.
 */
export function localAdversary(
  options: AdversaryOptions,
  pending: { droneId: number | null; waitingS: number }[],
  history: AdversaryMove[],
  avgReactionS: number | null,
  rnd: () => number,
): AdversaryMove {
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const fast = avgReactionS !== null && avgReactionS < 10;
  const wait = Math.round(fast ? 12 + rnd() * 8 : 18 + rnd() * 12);
  const slowest = [...pending].sort((a, b) => b.waitingS - a.waitingS)[0];
  if (slowest && slowest.waitingS >= 8 && options.eligible.SPOOF.length) {
    return {
      move: 'SPOOF', target_drone: pick(options.eligible.SPOOF), wait_s: wait, source: 'LOCAL',
      reason: `O decizie aștepta de ${Math.round(slowest.waitingS)} s: am adăugat presiune cu încă o dronă falsificată.`,
    };
  }
  const used = new Set(history.map(m => m.move));
  const moves = options.available.filter(m => m !== 'WAIT');
  if (!moves.length) return { move: 'WAIT', target_drone: null, wait_s: wait, source: 'LOCAL', reason: 'Nimic nou de încercat acum.' };
  const fresh = moves.filter(m => !used.has(m));
  const last = history.at(-1)?.move;
  const move = pick(fresh.length ? fresh : moves.filter(m => m !== last).length ? moves.filter(m => m !== last) : moves);
  const target = move === 'SPOOF' ? pick(options.eligible.SPOOF) : move === 'LINK_LOSS' ? pick(options.eligible.LINK_LOSS) : null;
  const why = fresh.length ? 'Un tip de atac pe care operatorul nu l-a mai întâlnit în sesiune.' : 'Variez presiunea, fără să repet ultima mutare.';
  return { move, target_drone: target, wait_s: wait, source: 'LOCAL', reason: fast ? `${why} Operatorul e rapid: ritm mai alert.` : why };
}

/** The debrief when Gemini isn't available: the same numbers, in fixed sentences. */
export function localDebrief(decisions: DecisionRecord[], redSeconds: Record<number, number>, score: number, grade: string) {
  const resolved = decisions.filter(d => d.reactionS !== null);
  const avg = resolved.length ? resolved.reduce((a, d) => a + d.reactionS!, 0) / resolved.length : null;
  const who = (d: DecisionRecord) => (d.droneId ? `D${d.droneId}` : 'patrulă');
  const verb = (d: DecisionRecord) => ({ APPROVED: 'Ai aprobat', REJECTED: 'Ai respins', OVERRIDDEN: 'Ai dat altă comandă în locul a', MISSED: '' })[d.outcome];

  const strengths: string[] = [];
  const fastOnes = resolved.filter(d => d.reactionS! <= TARGET_REACTION_S);
  if (fastOnes.length) {
    const best = [...fastOnes].sort((a, b) => a.reactionS! - b.reactionS!)[0];
    strengths.push(`${fastOnes.length} din ${decisions.length} decizii luate sub ${TARGET_REACTION_S} s; cea mai rapidă: ${actionRo(best.action)} pentru ${who(best)} în ${Math.round(best.reactionS!)} s.`);
  }
  if (decisions.length && decisions.every(d => d.reactionS !== null)) strengths.push('Nicio recomandare nu a rămas fără răspuns.');
  if (!strengths.length) strengths.push('Ai dus sesiunea până la capăt: rezultatele de mai jos arată unde poți câștiga timp.');

  const improvements: string[] = [];
  for (const d of [...resolved].filter(d => d.reactionS! > TARGET_REACTION_S).sort((a, b) => b.reactionS! - a.reactionS!).slice(0, 2)) {
    improvements.push(`${verb(d)} ${actionRo(d.action)} pentru ${who(d)} în ${Math.round(d.reactionS!)} s; ținta este sub ${TARGET_REACTION_S} s.`);
  }
  for (const d of decisions.filter(d => d.reactionS === null).slice(0, 2)) {
    improvements.push(`Recomandarea pentru ${who(d)} (${actionRo(d.action)}) a rămas fără decizie: verifică panoul de decizii după fiecare alertă.`);
  }
  const worstRed = Object.entries(redSeconds).sort((a, b) => b[1] - a[1])[0];
  if (worstRed && worstRed[1] >= 30 && improvements.length < 3) {
    improvements.push(`D${worstRed[0]} a stat ${Math.round(worstRed[1])} s pe roșu: o retragere aprobată mai devreme scurtează timpul ăsta.`);
  }
  if (!improvements.length) improvements.push('Păstrează ritmul: încearcă o sesiune la viteză 2× pentru mai multă presiune.');

  const summary =
    `Scor ${score}/100 (${grade}). ` +
    (decisions.length
      ? `Ai avut ${decisions.length} decizii de luat` + (avg !== null ? `, cu un timp mediu de reacție de ${Math.round(avg)} s (ținta: sub ${TARGET_REACTION_S} s).` : ', dar niciuna nu a primit răspuns.')
      : 'Adversarul nu a reușit să genereze decizii în această sesiune.');
  return { summary, strengths: strengths.slice(0, 3), improvements: improvements.slice(0, 3) };
}
