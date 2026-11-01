import { AuditEvent } from './models';

/**
 * Radio log helpers: RADIO_TRANSMISSION records (Backend/app/services/radio_service.py, or the
 * Demo simulator) read as chat entries, with the drones mentioned and the kind of transmission.
 */

export type RadioKind = 'REPORT' | 'ORDER' | 'QUESTION' | 'ACK' | 'OTHER';

export const KIND_LABELS: Record<RadioKind, string> = {
  REPORT: 'Raport',
  ORDER: 'Ordin',
  QUESTION: 'Întrebare',
  ACK: 'Confirmare',
  OTHER: 'Altele',
};

export interface RadioEntry {
  id: number;
  missionTime: number | null;
  speaker: string;
  text: string;
  drones: number[];
  kind: RadioKind;
  simulated: boolean;
}

/** Drones named in a transcript ("D3", "drona 3"), each once, in order of mention. */
export function dronesIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b(?:D|drona\s+|drone\s+)(\d{1,2})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Best guess when a record carries no kind (older records): questions and acknowledgements are easy to spot. */
export function guessKind(text: string): RadioKind {
  const t = text.trim().toLowerCase();
  if (t.endsWith('?')) return 'QUESTION';
  if (/^(recepționat|receptionat|am înțeles|am inteles|confirm|copy|roger|affirmative|afirmativ)\b/.test(t)) return 'ACK';
  return 'REPORT';
}

const KINDS = new Set<string>(Object.keys(KIND_LABELS));

export function radioEntry(e: AuditEvent): RadioEntry | null {
  if (e.event_type !== 'RADIO_TRANSMISSION') return null;
  let d: Record<string, unknown> = {};
  try {
    const v = JSON.parse(e.details);
    if (v && typeof v === 'object') d = v;
  } catch { /* not JSON: no transcript */ }
  const text = typeof d['transcript'] === 'string' ? (d['transcript'] as string) : '';
  if (!text) return null;
  const tagged = Array.isArray(d['drones']) ? (d['drones'] as unknown[]).filter((x): x is number => typeof x === 'number') : null;
  const kind = typeof d['kind'] === 'string' && KINDS.has(d['kind'] as string) ? (d['kind'] as RadioKind) : guessKind(text);
  return {
    id: e.id,
    missionTime: typeof d['mission_time_s'] === 'number' ? (d['mission_time_s'] as number) : null,
    speaker: e.operator_id,
    text,
    drones: tagged ?? dronesIn(text),
    kind,
    simulated: d['simulated'] === true,
  };
}

/**
 * The transmission plus what the system logged around it (±windowS of mission time), so a click
 * on a transmission shows the log at that moment. The transmission's own id comes first.
 */
export function contextIds(events: AuditEvent[], entry: RadioEntry, windowS = 20): number[] {
  if (entry.missionTime === null) return [entry.id];
  const around = events.filter(e => {
    if (e.id === entry.id || e.event_type === 'RADIO_TRANSMISSION') return false;
    try {
      const t = JSON.parse(e.details)?.mission_time_s;
      return typeof t === 'number' && Math.abs(t - entry.missionTime!) <= windowS;
    } catch {
      return false;
    }
  });
  return [entry.id, ...around.map(e => e.id)];
}

export function missionClock(t: number | null): string {
  if (t === null) return '—';
  const s = Math.max(0, Math.floor(t));
  return `T+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
