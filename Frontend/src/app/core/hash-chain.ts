import { AuditEvent, ChainVerification } from './models';

export const GENESIS_HASH = '0'.repeat(64);

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** JSON with object keys sorted at every level, like Python's json.dumps(sort_keys=True). */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function payload(e: Omit<AuditEvent, 'id' | 'curr_hash'>): string {
  return [e.prev_hash, e.timestamp, e.event_type, e.drone_id ?? 'null', e.details, e.operator_id].join('|');
}

/** Append-only ledger used by offline mode; each record carries the previous record's hash. */
export class HashChainLedger {
  private records: AuditEvent[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  get events(): AuditEvent[] {
    return this.records;
  }

  append(eventType: string, droneId: number | null, details: Record<string, unknown>, operatorId = 'SYSTEM'): Promise<AuditEvent> {
    // Serialise appends so prev_hash is always the true predecessor.
    const next = this.queue.then(async () => {
      const prev = this.records.at(-1);
      const base = {
        timestamp: new Date().toISOString(),
        event_type: eventType,
        drone_id: droneId,
        details: sortedJson(details),
        operator_id: operatorId,
        prev_hash: prev ? prev.curr_hash : GENESIS_HASH,
      };
      const record: AuditEvent = { id: this.records.length + 1, ...base, curr_hash: await sha256Hex(payload(base)) };
      this.records = [...this.records, record];
      return record;
    });
    this.queue = next;
    return next;
  }

  /** Demo-only: silently edit one record to show that verification catches it. */
  tamper(index: number): void {
    const target = this.records[index];
    if (!target) return;
    this.records = this.records.map((r, i) =>
      i === index ? { ...r, details: r.details.replace(/}$/, ',"edited":true}') } : r,
    );
  }

  reset(): void {
    this.records = [];
    this.queue = Promise.resolve();
  }
}

export async function verifyChain(events: AuditEvent[]): Promise<ChainVerification> {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.prev_hash !== prev || (await sha256Hex(payload(e))) !== e.curr_hash) {
      return {
        is_valid: false,
        broken_at_index: i,
        total_events: events.length,
        message: `Hash chain broken at record #${e.id} (${e.event_type}).`,
      };
    }
    prev = e.curr_hash;
  }
  return {
    is_valid: true,
    broken_at_index: null,
    total_events: events.length,
    message: `Hash chain intact across ${events.length} records.`,
  };
}
