import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { ORION_CONFIG } from './config';
import { ActionOption, evaluateActions } from './geo';
import { verifyChain } from './hash-chain';
import {
  AuditEvent, ChainVerification, CopilotMessage, DataMode, DroneState, FleetUpdate, LinkState, Recommendation, SocketMessage, Zone,
} from './models';
import { HttpErrorResponse } from '@angular/common/http';
import { OfflineSimulator } from './offline-simulator';
import { OrionApi, SimulationAction } from './orion-api.service';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'critical' | 'ok';
  title: string;
  body: string;
  count?: number;
}

export type Trigger =
  | 'random'
  | 'spoofing'
  | 'replay'
  | 'interference'
  | 'linkloss'
  | 'corridor-appear'
  | 'corridor-disappear'
  | 'danger-appear'
  | 'danger-disappear'
  | 'weather-storm'
  | 'weather-rain'
  | 'weather-wind'
  | 'weather-clear';

const HISTORY_LEN = 90;

/** Events worth interrupting the operator for, with how loud they are. */
const ALERTS: Record<string, { level: Toast['level']; title: string }> = {
  SPOOFING_ATTACK_INITIATED: { level: 'critical', title: 'GPS spoofing detected' },
  RECOMMENDATION_ISSUED: { level: 'warn', title: 'Decision needed' },
  COMMAND_REPLAY_REJECTED: { level: 'critical', title: 'Replayed command rejected' },
  COMMAND_AUTH_FAILED: { level: 'critical', title: 'Unauthenticated command rejected' },
  ZONE_INTERFERENCE_MARKED: { level: 'warn', title: 'EW jammer active in sector' },
  SAFE_CORRIDOR_ESTABLISHED: { level: 'ok', title: 'New safe corridor opened' },
  SAFE_CORRIDOR_COMPROMISED: { level: 'warn', title: 'Safe corridor compromised' },
  THREAT_ZONE_DETECTED: { level: 'critical', title: 'New danger zone detected' },
  THREAT_ZONE_CLEARED: { level: 'ok', title: 'Danger zone cleared' },
  GPS_RESTORED: { level: 'ok', title: 'GPS lock restored' },
  OPERATOR_APPROVAL: { level: 'ok', title: 'Action approved' },
  OPERATOR_COMMAND: { level: 'ok', title: 'Signed command sent' },
  MISSION_REPORT_READY: { level: 'info', title: 'Post-action report ready' },
  DRONE_RECOVERED: { level: 'ok', title: 'Drone recovered at base' },
  ROUTE_REPLANNED: { level: 'warn', title: 'Route re-planned' },
  WEATHER_CELL_DETECTED: { level: 'warn', title: 'Weather moving in' },
  WEATHER_LIMIT_EXCEEDED: { level: 'critical', title: 'Drone beyond weather limits' },
  WEATHER_CLEARED: { level: 'ok', title: 'Weather cleared' },
  GPS_DEGRADED_SINGLE: { level: 'warn', title: 'GPS lost on one drone' },
  COMMAND_LINK_LOST: { level: 'critical', title: 'Command link lost' },
  FAILSAFE_APPLIED: { level: 'warn', title: 'Failsafe applied' },
  COMMAND_LINK_RESTORED: { level: 'ok', title: 'Command link restored' },
};

/**
 * Single source of truth for the dashboard. In "live" mode it listens to the backend
 * WebSocket and polls REST; in "offline" (Demo) mode it drives the deterministic 3-minute demo simulator.
 */
@Injectable({ providedIn: 'root' })
export class OrionStore implements OnDestroy {
  private api = inject(OrionApi);

  readonly mode = signal<DataMode>(this.savedMode());
  readonly link = signal<LinkState>('connecting');
  readonly running = signal(false);
  readonly elapsed = signal(0);
  readonly drones = signal<DroneState[]>([]);
  readonly zones = signal<Zone[]>([]);
  readonly events = signal<AuditEvent[]>([]);
  readonly recommendations = signal<Recommendation[]>([]);
  readonly sectorInterference = signal(false);
  readonly selectedDroneId = signal<number | null>(null);
  readonly verification = signal<ChainVerification | null>(null);
  readonly toasts = signal<Toast[]>([]);
  readonly trustHistory = signal<Record<number, number[]>>({});
  readonly speed = signal(1);
  readonly muted = signal(this.savedMuted());
  readonly busy = signal(false);
  readonly copilot = signal<CopilotMessage[]>([]);
  readonly copilotBusy = signal(false);
  /** Log records the operator asked to see (copilot citations); the log scrolls to them. */
  readonly highlightedEvents = signal<number[]>([]);

  readonly selectedDrone = computed(() => this.drones().find(d => d.drone_id === this.selectedDroneId()) ?? null);
  /** Drone whose details panel is open (only ever opened by the operator, never by alerts). */
  readonly detailsDroneId = signal<number | null>(null);
  readonly detailsDrone = computed(() => this.drones().find(d => d.drone_id === this.detailsDroneId()) ?? null);
  readonly pendingRecommendations = computed(() => this.recommendations().filter(r => r.status === 'PENDING'));
  readonly fleetCounts = computed(() => {
    const ds = this.drones();
    return {
      total: ds.length,
      green: ds.filter(d => d.trust_status === 'GREEN').length,
      yellow: ds.filter(d => d.trust_status === 'YELLOW').length,
      red: ds.filter(d => d.trust_status === 'RED').length,
    };
  });

  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private offline: OfflineSimulator | null = null;
  private lastAlertedId = 0;
  private toastSeq = 0;
  private audio: AudioContext | null = null;

  constructor() {
    this.activate(this.mode(), true);
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  // ---- mode switching ---------------------------------------------------------------------

  setMode(mode: DataMode, remember = true): void {
    if (mode === this.mode()) return;
    this.mode.set(mode);
    if (remember) {
      try { localStorage.setItem('orion.mode', mode); } catch { /* storage unavailable */ }
    }
    this.activate(mode, false);
  }

  private activate(mode: DataMode, allowFallback: boolean): void {
    this.teardown();
    this.drones.set([]);
    this.events.set([]);
    this.recommendations.set([]);
    this.verification.set(null);
    this.trustHistory.set({});
    this.clearCopilot();
    this.lastAlertedId = 0;
    this.elapsed.set(0);
    if (mode === 'live') this.connectLive(allowFallback);
    else this.startOffline();
  }

  private teardown(): void {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    for (const t of [this.reconnectTimer, this.fallbackTimer]) if (t) clearTimeout(t);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.reconnectTimer = this.fallbackTimer = this.pollTimer = null;
    this.offline?.dispose();
    this.offline = null;
  }

  // ---- live backend ----------------------------------------------------------------------

  private connectLive(allowFallback: boolean): void {
    this.link.set('connecting');
    if (allowFallback) {
      this.fallbackTimer = setTimeout(() => {
        if (this.link() !== 'online') {
          this.pushToast('warn', 'Backend unreachable', `No answer from ${ORION_CONFIG.apiBase}. Switched to Demo mode.`);
          this.setMode('offline', false);
        }
      }, 4000);
    }
    this.openSocket();
    this.pollLive();
    this.pollTimer = setInterval(() => this.pollLive(), ORION_CONFIG.pollIntervalMs);
  }

  private openSocket(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(ORION_CONFIG.wsUrl);
    } catch {
      this.link.set('offline');
      return;
    }
    this.socket = ws;
    ws.onopen = () => this.link.set('online');
    ws.onmessage = ev => {
      try {
        this.handleSocket(JSON.parse(ev.data) as SocketMessage);
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => {
      this.link.set('offline');
      this.socket = null;
      this.reconnectTimer = setTimeout(() => this.openSocket(), 2500);
    };
  }

  private handleSocket(msg: SocketMessage): void {
    if (msg.type === 'FLEET_UPDATE') {
      this.applyFleet(msg);
      this.running.set(true);
    } else if (msg.type === 'SNAPSHOT') {
      this.zones.set(msg.zones);
      this.running.set(msg.simulator_running);
      this.elapsed.set(msg.elapsed_time);
    }
  }

  private async pollLive(): Promise<void> {
    const [eventsRes, recsRes, statusRes] = await Promise.allSettled([
      this.api.events(),
      this.api.recommendations(),
      this.api.simulationStatus(),
    ]);
    if (eventsRes.status === 'fulfilled') this.setEvents(eventsRes.value);
    if (recsRes.status === 'fulfilled') this.recommendations.set(recsRes.value);
    if (statusRes.status === 'fulfilled') {
      this.running.set(statusRes.value.is_running);
      if (!statusRes.value.is_running) this.elapsed.set(statusRes.value.elapsed_time);
    }
  }

  // ---- demo simulator --------------------------------------------------------------------

  private startOffline(): void {
    this.link.set('offline');
    this.offline = new OfflineSimulator({
      onFleet: u => this.applyFleet(u),
      onLedger: () => this.setEvents(this.offline!.ledger.events),
      onRecommendations: recs => this.recommendations.set(recs),
    });
    this.offline.speed = this.speed();
    this.running.set(false);
  }

  // ---- shared state updates --------------------------------------------------------------

  private applyFleet(u: FleetUpdate): void {
    this.drones.set(u.drones);
    this.zones.set(u.zones);
    this.elapsed.set(u.elapsed_time);
    this.sectorInterference.set(u.active_sector_interference);
    this.trustHistory.update(h => {
      const next = { ...h };
      for (const d of u.drones) next[d.drone_id] = [...(h[d.drone_id] ?? []), d.trust_score].slice(-HISTORY_LEN);
      return next;
    });
    if (this.selectedDroneId() === null) {
      const worst = [...u.drones].sort((a, b) => a.trust_score - b.trust_score)[0];
      if (worst && worst.trust_status !== 'GREEN') this.selectedDroneId.set(worst.drone_id);
    }
  }

  private setEvents(events: AuditEvent[]): void {
    // A new record invalidates the last verification result.
    if (events.at(-1)?.id !== this.events().at(-1)?.id) this.verification.set(null);
    this.events.set(events);
    const fresh = events.filter(e => e.id > this.lastAlertedId);
    if (this.lastAlertedId === 0 && this.mode() === 'live') {
      // First load of an existing ledger: don't replay old alerts.
      this.lastAlertedId = events.at(-1)?.id ?? 0;
      return;
    }
    for (const e of fresh) {
      const alert = ALERTS[e.event_type];
      if (alert) {
        this.pushToast(alert.level, alert.title, summarise(e));
        if (e.drone_id && (alert.level === 'critical' || e.event_type === 'RECOMMENDATION_ISSUED')) {
          this.selectedDroneId.set(e.drone_id);
        }
      }
    }
    if (fresh.length) this.lastAlertedId = fresh.at(-1)!.id;
  }

  // ---- operator actions ------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.offline) {
      this.offline.start();
      this.running.set(true);
    } else {
      await this.call(() => this.api.simulation('start'));
    }
  }

  async pause(): Promise<void> {
    if (this.offline) {
      this.offline.stop();
      this.running.set(false);
    } else {
      await this.call(() => this.api.simulation('stop'));
      this.running.set(false);
    }
  }

  async reset(): Promise<void> {
    this.selectedDroneId.set(null);
    this.trustHistory.set({});
    this.verification.set(null);
    this.toasts.set([]);
    this.clearCopilot();
    this.lastAlertedId = 0;
    if (this.offline) {
      this.offline.reset();
      this.running.set(false);
    } else {
      await this.call(() => this.api.simulation('reset'));
      this.running.set(false);
    }
  }

  async trigger(kind: Trigger): Promise<void> {
    if (this.offline) {
      if (kind === 'spoofing') this.offline.triggerSpoofing();
      if (kind === 'replay') this.offline.triggerReplay();
      if (kind === 'interference') this.offline.triggerInterference();
      if (kind === 'linkloss') this.offline.triggerLinkLoss();
      if (kind === 'weather-storm') this.offline.triggerWeather('STORM');
      if (kind === 'weather-rain') this.offline.triggerWeather('RAIN');
      if (kind === 'weather-wind') this.offline.triggerWeather('WIND');
      if (kind === 'weather-clear') this.offline.clearWeather();
      return;
    }
    if (kind === 'linkloss') return; // Demo-only scenario beat
    if (kind === 'weather-storm' || kind === 'weather-rain' || kind === 'weather-wind') {
      const wx = ({ 'weather-storm': 'STORM', 'weather-rain': 'RAIN', 'weather-wind': 'WIND' } as const)[kind];
      await this.call(() => this.api.weatherAppear(wx));
      this.pollLive();
      return;
    }
    const actionMap: Record<Exclude<Trigger, 'linkloss' | 'weather-storm' | 'weather-rain' | 'weather-wind'>, SimulationAction> = {
      random: 'trigger-random',
      spoofing: 'trigger-spoofing',
      replay: 'trigger-replay',
      interference: 'trigger-sector-interference',
      'corridor-appear': 'trigger-corridor-appear',
      'corridor-disappear': 'trigger-corridor-disappear',
      'danger-appear': 'trigger-danger-appear',
      'danger-disappear': 'trigger-danger-disappear',
      'weather-clear': 'trigger-weather-clear',
    };
    const action = actionMap[kind];
    await this.call(() => this.api.simulation(action));
    this.pollLive();
  }

  setSpeed(speed: number): void {
    this.speed.set(speed);
    if (this.offline) this.offline.speed = speed;
  }

  /** Operator picks an action for a drone directly, instead of approving an ORION recommendation. */
  async commandDrone(droneId: number, action: ActionOption['id']): Promise<void> {
    // Re-check against the latest position and zones: the list on screen may be a tick old.
    const drone = this.drones().find(d => d.drone_id === droneId);
    const option = drone && evaluateActions(drone, this.zones()).find(a => a.id === action);
    if (!option?.allowed) {
      this.pushToast('critical', 'Command blocked', option ? `${option.label}: ${option.reason}` : `Drone ${droneId} not found`);
      return;
    }
    if (this.offline) {
      const res = this.offline.command(droneId, action, ORION_CONFIG.operatorId);
      if (!res.ok) this.pushToast('warn', 'Command not sent', res.message);
      return;
    }
    const res = await this.call(() => this.api.command(droneId, action, option.reason));
    if (res?.signed_command) {
      this.pushToast('ok', 'Signed command sent', `${res.signed_command.command} → Drone ${res.signed_command.drone_id} (seq ${res.signed_command.sequence})`);
    }
    this.pollLive();
  }

  async decide(rec: Recommendation, decision: 'APPROVE' | 'REJECT'): Promise<void> {
    if (this.offline) {
      const res = this.offline.decide(rec.id, decision, ORION_CONFIG.operatorId);
      if (!res.ok) this.pushToast('warn', 'Decision not applied', res.message);
      return;
    }
    const res = await this.call(() => this.api.decide(rec.id, decision));
    if (res?.signed_command) {
      this.pushToast('ok', 'Signed command sent', `${res.signed_command.command} → Drone ${res.signed_command.drone_id} (seq ${res.signed_command.sequence})`);
    }
    this.pollLive();
  }

  async verify(): Promise<ChainVerification | null> {
    const result = this.offline
      ? await verifyChain(this.offline.ledger.events)
      : await this.call(() => this.api.verify());
    if (result) this.verification.set(result);
    return result;
  }

  /** Demo-only demonstration that editing any record breaks the chain. */
  async tamperDemo(): Promise<void> {
    if (!this.offline) return;
    const evs = this.offline.ledger.events;
    if (evs.length < 2) return;
    this.offline.ledger.tamper(Math.floor(evs.length / 2));
    this.events.set(this.offline.ledger.events);
    await this.verify();
  }

  async buildReport() {
    if (!this.offline) return this.call(() => this.api.exportReport());
    const timeline = this.offline.ledger.events;
    const verification = await verifyChain(timeline);
    const counts: Record<string, number> = {};
    for (const e of timeline) counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
    return {
      mission_id: ORION_CONFIG.missionId,
      generated_at: new Date().toISOString(),
      verification,
      timeline,
      summary: {
        total_events: timeline.length,
        event_counts: counts,
        affected_drones: [...new Set(timeline.map(e => e.drone_id).filter((d): d is number => d !== null))],
        source: 'DEMO_MODE',
      },
    };
  }

  /**
   * Asks the read-only copilot about the mission. It answers only from the hash-chained log
   * (plus the live fleet snapshot) and cites record ids; it can't send commands.
   */
  async askCopilot(question: string): Promise<void> {
    const q = question.trim();
    if (!q || this.copilotBusy()) return;
    const history = this.copilot()
      .filter(m => !m.error)
      .map(m => ({ role: m.role, content: m.text }));
    this.copilot.update(ms => [...ms, { role: 'user', text: q }]);
    this.copilotBusy.set(true);
    try {
      const fleet = this.drones().map(d => ({
        drone_id: d.drone_id, trust_score: d.trust_score, trust_status: d.trust_status,
        flight_mode: d.flight_mode, reason: d.reason,
      }));
      const body: Parameters<OrionApi['copilotAsk']>[0] = { question: q, history, fleet, elapsed_s: this.elapsed() };
      if (this.offline) {
        // The demo ledger only exists in this browser: send it, with our own chain check.
        const events = this.offline.ledger.events;
        body.events = events.map(({ prev_hash: _p, curr_hash: _c, ...rest }) => rest);
        body.chain_valid = (await verifyChain(events)).is_valid;
      }
      const res = await this.api.copilotAsk(body);
      this.copilot.update(ms => [...ms, {
        role: 'assistant',
        text: res.answer,
        citedIds: res.cited_ids,
        meta: `${res.records} records · chain ${res.chain_valid ? 'verified' : 'BROKEN'} · ${res.model}`,
      }]);
    } catch (err) {
      // Mark the question too, so a failed exchange isn't replayed as history next time.
      this.copilot.update(ms => [
        ...ms.slice(0, -1),
        { ...ms[ms.length - 1], error: true },
        { role: 'assistant', text: copilotError(err), error: true },
      ]);
    } finally {
      this.copilotBusy.set(false);
    }
  }

  clearCopilot(): void {
    this.copilot.set([]);
    this.highlightedEvents.set([]);
  }

  highlightEvents(ids: number[]): void {
    this.highlightedEvents.set(ids);
  }

  /** Operator clicked a drone: select it and open its details (a second click closes them). */
  openDetails(id: number): void {
    if (this.detailsDroneId() === id) {
      this.detailsDroneId.set(null);
      return;
    }
    this.selectedDroneId.set(id);
    this.detailsDroneId.set(id);
  }

  closeDetails(): void {
    this.detailsDroneId.set(null);
  }

  selectDrone(id: number | null): void {
    this.selectedDroneId.set(id);
  }

  dismissToast(id: number): void {
    this.toasts.update(ts => ts.filter(t => t.id !== id));
  }

  toggleMute(): void {
    this.muted.update(m => !m);
    try { localStorage.setItem('orion.muted', String(this.muted())); } catch { /* storage unavailable */ }
  }

  private lastBeepAt = 0;

  clearAllToasts(): void {
    this.toasts.set([]);
  }

  pushToast(level: Toast['level'], title: string, body: string): void {
    const existing = this.toasts().find(t => t.title === title && t.level === level);
    if (existing) {
      const newCount = (existing.count ?? 1) + 1;
      this.toasts.update(ts => ts.map(t => t.id === existing.id ? { ...t, body, count: newCount } : t));
      setTimeout(() => this.dismissToast(existing.id), level === 'critical' ? 5500 : 3800);
      return;
    }

    const id = ++this.toastSeq;
    // Cap visible notifications to at most 2 so they never flood or disorient the operator
    this.toasts.update(ts => [...ts, { id, level, title, body, count: 1 }].slice(-2));
    setTimeout(() => this.dismissToast(id), level === 'critical' ? 6000 : 4000);

    const now = Date.now();
    if ((level === 'critical' || level === 'warn') && now - this.lastBeepAt > 800) {
      this.lastBeepAt = now;
      this.beep(level === 'critical' ? 880 : 620);
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T | null> {
    this.busy.set(true);
    try {
      return await fn();
    } catch (err: unknown) {
      const detail = (err as { error?: { detail?: string }; message?: string })?.error?.detail ?? (err as Error)?.message ?? 'Request failed';
      this.pushToast('warn', 'Backend error', String(detail));
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  private beep(freq: number): void {
    if (this.muted()) return;
    try {
      this.audio ??= new AudioContext();
      const osc = this.audio.createOscillator();
      const gain = this.audio.createGain();
      osc.frequency.value = freq;
      osc.type = 'square';
      gain.gain.setValueAtTime(0.04, this.audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.audio.currentTime + 0.25);
      osc.connect(gain).connect(this.audio.destination);
      osc.start();
      osc.stop(this.audio.currentTime + 0.25);
    } catch { /* audio not available */ }
  }

  private savedMode(): DataMode {
    try { return localStorage.getItem('orion.mode') === 'offline' ? 'offline' : 'live'; } catch { return 'live'; }
  }

  private savedMuted(): boolean {
    try { return localStorage.getItem('orion.muted') === 'true'; } catch { return false; }
  }
}

export function parseDetails(e: AuditEvent): Record<string, unknown> {
  try {
    const v = JSON.parse(e.details);
    return v && typeof v === 'object' ? v : { text: e.details };
  } catch {
    return { text: e.details };
  }
}

export function summarise(e: AuditEvent): string {
  const d = parseDetails(e);
  const pick = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
  const drone = e.drone_id ? `Drone ${e.drone_id}: ` : '';
  return drone + (pick('blocked_reason') ?? pick('reason') ?? pick('assessment') ?? pick('description') ?? pick('action') ?? pick('summary') ?? pick('text') ?? e.event_type.replaceAll('_', ' ').toLowerCase());
}

function copilotError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return `The copilot runs on the ORION backend, which isn't reachable at ${ORION_CONFIG.apiBase}. Start the backend (with internet and ANTHROPIC_API_KEY) to ask questions.`;
    }
    if (typeof err.error?.detail === 'string') return err.error.detail;
    return `Copilot error (${err.status}).`;
  }
  return 'Copilot error.';
}
