import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { ORION_CONFIG } from './config';
import { ActionOption, distanceM, evaluateActions } from './geo';
import { verifyChain } from './hash-chain';
import {
  AuditEvent, ChainVerification, CopilotMessage, DataMode, DroneState, FleetUpdate, LinkState, Recommendation, SocketMessage, Zone,
} from './models';
import { HttpErrorResponse } from '@angular/common/http';
import { OfflineSimulator } from './offline-simulator';
import { OrionApi, SimulationAction } from './orion-api.service';
import { RadioEntry, radioEntry } from './radio';
import {
  AdversaryMove, FIRST_MOVE_AT_S, SESSION_LENGTH_S, TARGET_REACTION_S, TrainingDebrief, decisionsFromLog, localAdversary, localDebrief,
  scoreSession, seededRandom,
} from './training';

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

/** An AI training session in Demo mode (core/training.ts). */
export interface TrainingSession {
  phase: 'running' | 'debriefing' | 'done';
  startedAt: number;
  lengthS: number;
  nextMoveAt: number;
  requesting: boolean;
  /** Who plays the adversary: Gemini on the backend, or the local rules once that failed. */
  adversary: 'AI' | 'LOCAL';
  moves: AdversaryMove[];
  redSeconds: Record<number, number>;
  lastElapsed: number;
  debrief: TrainingDebrief | null;
}

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
  readonly randomIntervalMin = signal<number>(this.savedIntervalMin());
  readonly randomIntervalMax = signal<number>(this.savedIntervalMax());
  readonly copilot = signal<CopilotMessage[]>([]);
  readonly copilotBusy = signal(false);
  /** Log records the operator asked to see (copilot citations); the log scrolls to them. */
  readonly highlightedEvents = signal<number[]>([]);
  readonly mapMode = signal<'view' | 'create_patrol' | 'create_threat' | 'create_corridor' | 'delete_zone' | 'pick_loiter'>('view');
  readonly pickedLoiterPoint = signal<[number, number] | null>(null);
  readonly training = signal<TrainingSession | null>(null);
  /** Push-to-talk: idle, keyed (recording) or waiting for the transcript. */
  readonly radio = signal<'idle' | 'recording' | 'transcribing'>('idle');
  readonly radioSeconds = signal(0);
  /** Every transmission in the log, oldest first (the Radio panel). */
  readonly radioEntries = computed(() => this.events().map(radioEntry).filter((e): e is RadioEntry => e !== null));
  /** What was just said about each drone, shown as a bubble on the map for a few seconds. */
  readonly radioBubbles = signal<Record<number, { text: string; speaker: string; id: number }>>({});
  readonly commandScope = signal<'drone' | 'zone'>('drone');

  setMapMode(mode: 'view' | 'create_patrol' | 'create_threat' | 'create_corridor' | 'delete_zone' | 'pick_loiter'): void {
    this.mapMode.set(mode);
  }

  setCommandScope(scope: 'drone' | 'zone'): void {
    this.commandScope.set(scope);
  }

  setPickedLoiterPoint(point: [number, number] | null): void {
    this.pickedLoiterPoint.set(point);
  }

  readonly selectedDrone = computed(() => this.drones().find(d => d.drone_id === this.selectedDroneId()) ?? null);
  /** Drone whose details panel is open (only ever opened by the operator, never by alerts). */
  readonly detailsDroneId = signal<number | null>(null);
  readonly detailsDrone = computed(() => this.drones().find(d => d.drone_id === this.detailsDroneId()) ?? null);
  readonly pendingRecommendations = computed(() => this.recommendations().filter(r => r.status === 'PENDING'));
  readonly activePatrolZones = computed(() => this.zones().filter(z => z.is_active && z.zone_type === 'PATROL'));
  readonly hasJammedPatrol = computed(() => {
    const pzs = this.activePatrolZones();
    const jammers = this.zones().filter(z => z.is_active && z.zone_type === 'INTERFERENCE' && z.center && z.radius_m);
    for (const pz of pzs) {
      if (!pz.center || !pz.radius_m) continue;
      for (const j of jammers) {
        if (distanceM(pz.center[0], pz.center[1], j.center![0], j.center![1]) < (pz.radius_m + j.radius_m!)) {
          return true;
        }
      }
    }
    return false;
  });
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
    this.training.set(null);
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
    ws.onopen = () => {
      this.link.set('online');
      this.api.setRandomInterval(this.randomIntervalMin(), this.randomIntervalMax()).catch(() => {});
    };
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
    if (u.random_interval_min !== undefined && u.random_interval_max !== undefined) {
      if (this.randomIntervalMin() !== u.random_interval_min || this.randomIntervalMax() !== u.random_interval_max) {
        this.randomIntervalMin.set(u.random_interval_min);
        this.randomIntervalMax.set(u.random_interval_max);
      }
    }
    this.trustHistory.update(h => {
      const next = { ...h };
      for (const d of u.drones) next[d.drone_id] = [...(h[d.drone_id] ?? []), d.trust_score].slice(-HISTORY_LEN);
      return next;
    });
    if (this.selectedDroneId() === null) {
      const worst = [...u.drones].sort((a, b) => a.trust_score - b.trust_score)[0];
      if (worst && worst.trust_status !== 'GREEN') this.selectedDroneId.set(worst.drone_id);
    }
    if (this.training()?.phase === 'running') this.trainingTick(u);
  }

  // ---- AI training (Demo) ------------------------------------------------------------------

  /** Starts a fresh Demo run where an adversary, not the fixed script, stages the attacks. */
  async startTraining(): Promise<void> {
    if (this.mode() !== 'offline') this.setMode('offline');
    await this.reset();
    if (!this.offline) return;
    this.offline.scripted = false;
    this.training.set({
      phase: 'running', startedAt: this.elapsed(), lengthS: SESSION_LENGTH_S, nextMoveAt: this.elapsed() + FIRST_MOVE_AT_S,
      requesting: false, adversary: 'AI', moves: [], redSeconds: {}, lastElapsed: this.elapsed(), debrief: null,
    });
    await this.start();
  }

  /** Ends the session now (or when time is up) and builds the debrief. */
  async finishTraining(): Promise<void> {
    const t = this.training();
    if (!t || t.phase !== 'running' || !this.offline) return;
    this.offline.stop();
    this.running.set(false);
    this.training.set({ ...t, phase: 'debriefing' });

    const end = this.elapsed();
    const events = this.offline.ledger.events;
    const decisions = decisionsFromLog(events, t.startedAt, end);
    const breaches = events.filter(e => e.event_type === 'WEATHER_LIMIT_EXCEEDED').length;
    const { score, grade, lines } = scoreSession(decisions, t.redSeconds, breaches, end);
    let text = localDebrief(decisions, t.redSeconds, score, grade);
    let source: 'AI' | 'LOCAL' = 'LOCAL';
    let model: string | undefined;
    try {
      const res = await this.api.trainingDebrief({
        score, duration_s: Math.round(end - t.startedAt),
        decisions: decisions.map(d => ({ drone_id: d.droneId, action: d.action, issued_at_s: d.issuedAt, reaction_s: d.reactionS, outcome: d.outcome })),
        red_seconds: Object.fromEntries(Object.entries(t.redSeconds).map(([k, v]) => [k, Math.round(v)])),
        attacks: t.moves.map(m => ({ at_s: m.at_s, move: m.move, target: m.target_drone, reason: m.reason })),
        extra: { grade, deductions: lines, target_reaction_s: TARGET_REACTION_S, weather_breaches: breaches },
      });
      text = { summary: res.summary, strengths: res.strengths, improvements: res.improvements };
      source = 'AI';
      model = res.model;
    } catch { /* backend or Gemini unavailable: keep the local debrief */ }
    const now = this.training();
    if (now?.phase !== 'debriefing') return; // reset while waiting
    this.training.set({ ...now, phase: 'done', debrief: { score, grade, lines, decisions, ...text, source, model } });
  }

  /** Closes the debrief and goes back to the regular scripted Demo. */
  async closeTraining(): Promise<void> {
    await this.reset();
  }

  private trainingTick(u: FleetUpdate): void {
    const t = this.training()!;
    const dt = Math.max(0, u.elapsed_time - t.lastElapsed);
    const redSeconds = { ...t.redSeconds };
    for (const d of u.drones) if (d.trust_status === 'RED') redSeconds[d.drone_id] = (redSeconds[d.drone_id] ?? 0) + dt;
    this.training.set({ ...t, redSeconds, lastElapsed: u.elapsed_time });
    if (u.elapsed_time - t.startedAt >= t.lengthS) {
      void this.finishTraining();
    } else if (u.elapsed_time >= t.nextMoveAt && !t.requesting) {
      void this.adversaryTurn();
    }
  }

  private async adversaryTurn(): Promise<void> {
    const sim = this.offline;
    const t = this.training();
    if (!sim || !t) return;
    this.training.set({ ...t, requesting: true });
    const options = sim.adversaryOptions();
    const now = this.elapsed();
    const decisions = decisionsFromLog(sim.ledger.events, t.startedAt, now);
    const resolved = decisions.filter(d => d.reactionS !== null);
    const avgReaction = resolved.length ? resolved.reduce((a, d) => a + d.reactionS!, 0) / resolved.length : null;
    const pending = this.pendingRecommendations().map(r => {
      const issued = decisions.find(d => d.recId === r.id)?.issuedAt ?? now;
      return { droneId: r.drone_id, action: r.recommended_action, waitingS: Math.round(now - issued) };
    });

    let move: AdversaryMove | null = null;
    if (t.adversary === 'AI') {
      try {
        const res = await this.api.trainingMove({
          elapsed_s: Math.round(now - t.startedAt), remaining_s: Math.round(t.lengthS - (now - t.startedAt)),
          available: options.available, eligible: options.eligible,
          drones: this.drones().map(d => ({ id: d.drone_id, status: d.trust_status, trust: Math.round(d.trust_score), mode: d.flight_mode })),
          pending_decisions: pending.map(p => ({ drone_id: p.droneId, action: p.action, waiting_s: p.waitingS })),
          operator: {
            decisions: decisions.length, avg_reaction_s: avgReaction === null ? null : Math.round(avgReaction),
            slowest_reaction_s: resolved.length ? Math.round(Math.max(...resolved.map(d => d.reactionS!))) : null,
            missed: decisions.filter(d => d.reactionS === null).length,
          },
          history: t.moves.map(m => ({ at_s: m.at_s, move: m.move, target: m.target_drone })),
        });
        move = { move: res.move, target_drone: res.target_drone, wait_s: res.wait_s, reason: res.reason, source: 'AI' };
      } catch {
        this.pushToast('info', 'Adversar local', 'Gemini nu răspunde: adversarul continuă cu regulile locale.');
      }
    }
    const current = this.training();
    if (!current || current.phase !== 'running' || this.offline !== sim) return; // ended while we waited
    const rnd = seededRandom(Math.round(now * 1000) + current.moves.length);
    move ??= localAdversary(options, pending, current.moves, avgReaction, rnd);
    // The AI's choice was made a few seconds ago: if it's no longer possible, play locally.
    if (!sim.applyAdversaryMove(move.move, move.target_drone)) {
      move = localAdversary(sim.adversaryOptions(), pending, current.moves, avgReaction, rnd);
      sim.applyAdversaryMove(move.move, move.target_drone, 'LOCAL_ADVERSARY');
    }
    this.training.set({
      ...current,
      requesting: false,
      adversary: move.source === 'AI' ? 'AI' : 'LOCAL',
      moves: [...current.moves, { ...move, at_s: Math.round(this.elapsed() - current.startedAt) }],
      nextMoveAt: this.elapsed() + move.wait_s,
    });
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
      if (e.event_type === 'RADIO_TRANSMISSION') this.showBubbles(e);
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
    this.training.set(null);
    this.radioBubbles.set({});
    if (this.offline) {
      this.offline.scripted = true;
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
  async commandDrone(
    droneId: number,
    action: string,
    targetZoneId?: number,
    targetPoint?: [number, number],
    pathType: 'SAFE' | 'RISKY' = 'SAFE',
  ): Promise<void> {
    const drone = this.drones().find(d => d.drone_id === droneId);
    if (!drone) {
      this.pushToast('critical', 'Command blocked', `Drone ${droneId} not found`);
      return;
    }
    let reasonText = '';
    if (action !== 'JOIN_PATROL' && action !== 'LOITER_AT') {
      const option = evaluateActions(drone, this.zones()).find(a => a.id === action);
      if (!option?.allowed) {
        this.pushToast('critical', 'Command blocked', option ? `${option.label}: ${option.reason}` : `Action not allowed`);
        return;
      }
      reasonText = option.reason;
    }
    if (this.offline) {
      const res = this.offline.command(droneId, action, ORION_CONFIG.operatorId, targetZoneId, targetPoint, pathType);
      if (!res.ok) this.pushToast('warn', 'Command not sent', res.message);
      return;
    }
    const res = await this.call(() =>
      this.api.command(droneId, action, reasonText, targetZoneId, targetPoint, pathType),
    );
    if (res?.signed_command) {
      this.pushToast(
        'ok',
        'Signed command sent',
        `${res.signed_command.command} → Drone ${res.signed_command.drone_id} (seq ${res.signed_command.sequence})`,
      );
    }
    this.pollLive();
  }

  async createPatrolZone(name: string, center: [number, number], radiusM: number): Promise<void> {
    if (this.offline) {
      this.offline.addPatrolZone(name, center, radiusM);
      this.pushToast('ok', 'Patrol zone created', `${name} (radius ${Math.round(radiusM)} m) active`);
      return;
    }
    const res = await this.call(() => this.api.createPatrolZone({ name, center, radius_m: radiusM }));
    if (res) {
      this.pushToast('ok', 'Patrol zone created', `${res.name} (radius ${Math.round(res.radius_m ?? radiusM)} m) active`);
    }
    this.pollLive();
  }

  async deleteZone(zoneId: number): Promise<void> {
    if (this.offline) {
      this.offline.deleteZone(zoneId);
      this.pushToast('ok', 'Zone deleted', `Tactical zone #${zoneId} deactivated`);
      return;
    }
    const res = await this.call(() => this.api.deleteZone(zoneId));
    if (res) {
      this.pushToast('ok', 'Zone deleted', `Tactical zone #${zoneId} deactivated`);
    }
    this.pollLive();
  }

  async createThreatZone(name: string, center: [number, number], radiusM: number): Promise<void> {
    if (this.offline) {
      this.offline.addThreatZone(name, center, radiusM);
      this.pushToast('warn', 'Threat zone established', `${name} (radius ${Math.round(radiusM)} m) active`);
      return;
    }
    const res = await this.call(() => this.api.createThreatZone({ name, center, radius_m: radiusM }));
    if (res) {
      this.pushToast('warn', 'Threat zone established', `${res.name} (radius ${Math.round(res.radius_m ?? radiusM)} m) active`);
    }
    this.pollLive();
  }

  async createSafeCorridor(name: string, waypoints: [number, number][]): Promise<void> {
    if (this.offline) {
      this.offline.addSafeCorridor(name, waypoints);
      this.pushToast('ok', 'Safe corridor opened', `${name} (${waypoints.length} waypoints) established`);
      return;
    }
    const res = await this.call(() => this.api.createSafeCorridor({ name, waypoints }));
    if (res) {
      this.pushToast('ok', 'Safe corridor opened', `${res.name} (${waypoints.length} waypoints) established`);
    }
    this.pollLive();
  }

  async executeZoneTactic(zoneId: number, tactic: string): Promise<void> {
    if (this.offline) {
      const res = this.offline.executeZoneTactic(zoneId, tactic);
      if (res.ok) {
        this.pushToast('ok', 'Tactic executed', res.message);
      } else {
        this.pushToast('warn', 'Tactic rejected', res.message);
      }
      return;
    }
    const res = await this.call(() => this.api.executeZoneTactic({ zone_id: zoneId, tactic }));
    if (res) {
      this.pushToast('ok', 'Tactic executed', `${tactic.replaceAll('_', ' ')} executed on Zone #${zoneId}`);
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

  // ---- radio log (push-to-talk) ------------------------------------------------------------

  /** A drone mentioned on the radio gets the line as a bubble on the map, then it fades. */
  private showBubbles(e: AuditEvent): void {
    const entry = radioEntry(e);
    if (!entry?.drones.length) return;
    const text = entry.text.length > 90 ? entry.text.slice(0, 88) + '…' : entry.text;
    this.radioBubbles.update(b => {
      const next = { ...b };
      for (const d of entry.drones) next[d] = { text, speaker: entry.speaker, id: e.id };
      return next;
    });
    setTimeout(() => this.radioBubbles.update(b => {
      const next = { ...b };
      for (const d of entry.drones) if (next[d]?.id === e.id) delete next[d];
      return next;
    }), 7000);
  }

  private recorder: MediaRecorder | null = null;
  private recStartedAt = 0;
  private recTimer: ReturnType<typeof setInterval> | null = null;
  private pttReleased = false;

  /** Mic keyed (button pressed or Space held): start recording one transmission. */
  async pttDown(): Promise<void> {
    if (this.radio() !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.pushToast('warn', 'Radio unavailable', 'This browser cannot record from the microphone.');
      return;
    }
    this.radio.set('recording');
    this.radioSeconds.set(0);
    this.pttReleased = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      this.radio.set('idle');
      this.pushToast('warn', 'Microphone blocked', 'Allow microphone access for this page to use push-to-talk.');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) ?? '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    const startedIso = new Date().toISOString();
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop()); // mic indicator off between transmissions
      const duration = (performance.now() - this.recStartedAt) / 1000;
      void this.sendTransmission(new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' }), duration, startedIso);
    };
    this.recorder = recorder;
    this.recStartedAt = performance.now();
    recorder.start();
    this.recTimer = setInterval(() => {
      const t = (performance.now() - this.recStartedAt) / 1000;
      this.radioSeconds.set(Math.floor(t));
      if (t >= 60) this.pttUp(); // a stuck key shouldn't record forever
    }, 250);
    if (this.pttReleased) this.pttUp(); // released while the permission prompt was open
  }

  /** Mic released: stop recording and send the transmission for transcription. */
  pttUp(): void {
    this.pttReleased = true;
    if (this.radio() !== 'recording' || !this.recorder) return;
    if (this.recTimer) clearInterval(this.recTimer);
    this.recTimer = null;
    const r = this.recorder;
    this.recorder = null;
    if (r.state !== 'inactive') r.stop();
  }

  private async sendTransmission(blob: Blob, durationS: number, startedIso: string): Promise<void> {
    if (durationS < 0.6 || blob.size < 500) {
      this.radio.set('idle');
      this.pushToast('info', 'Transmission too short', 'Hold the button (or Space) while you talk.');
      return;
    }
    this.radio.set('transcribing');
    const sim = this.offline;
    const startElapsed = this.elapsed() - durationS;
    try {
      const res = await this.api.radioTransmit({
        audio_base64: await blobToBase64(blob), mime_type: blob.type, duration_s: Math.round(durationS * 10) / 10,
        operator_id: ORION_CONFIG.operatorId, started_at: startedIso, log: !sim,
      });
      if (!res.transcript) {
        this.pushToast('info', 'Nothing understood', 'No speech was recognised in that transmission.');
      } else {
        if (sim && sim === this.offline) {
          sim.logRadio(res.transcript, ORION_CONFIG.operatorId, {
            duration_s: Math.round(durationS * 10) / 10, language: res.language, started_at: startedIso,
            drones: res.drones, kind: res.kind,
            transcribed_by: res.model, mission_time_s: Math.max(0, Math.round(startElapsed * 10) / 10),
          });
        } else if (!sim) {
          this.pollLive();
        }
        this.pushToast('ok', 'Radio logged', `„${res.transcript}”`);
      }
    } catch (err) {
      this.pushToast('warn', 'Transcription failed', radioError(err));
    } finally {
      this.radio.set('idle');
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
    if (id !== null) {
      this.commandScope.set('drone');
    }
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

  setRandomInterval(minS: number, maxS: number): void {
    const minVal = Math.max(1, Math.round(Math.min(minS, maxS) * 10) / 10);
    const maxVal = Math.max(minVal, Math.round(maxS * 10) / 10);
    this.randomIntervalMin.set(minVal);
    this.randomIntervalMax.set(maxVal);
    try {
      localStorage.setItem('orion.randomIntervalMin', String(minVal));
      localStorage.setItem('orion.randomIntervalMax', String(maxVal));
    } catch { /* storage unavailable */ }

    if (this.mode() === 'live') {
      this.api.setRandomInterval(minVal, maxVal).catch((err) => {
        console.warn('Failed to update random event interval on backend', err);
      });
    }
  }

  private savedIntervalMin(): number {
    try {
      const v = parseFloat(localStorage.getItem('orion.randomIntervalMin') ?? '');
      return !isNaN(v) && v > 0 ? v : 12;
    } catch {
      return 12;
    }
  }

  private savedIntervalMax(): number {
    try {
      const v = parseFloat(localStorage.getItem('orion.randomIntervalMax') ?? '');
      return !isNaN(v) && v > 0 ? v : 18;
    } catch {
      return 18;
    }
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
  const said = pick('transcript');
  if (said) return drone + `„${said}”` + (d['simulated'] ? ' (simulated)' : '');
  return drone + (pick('blocked_reason') ?? pick('reason') ?? pick('assessment') ?? pick('description') ?? pick('action') ?? pick('summary') ?? pick('text') ?? e.event_type.replaceAll('_', ' ').toLowerCase());
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function radioError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return `Transcription runs on the ORION backend, which isn't reachable at ${ORION_CONFIG.apiBase}.`;
    if (typeof err.error?.detail === 'string') return err.error.detail;
    return `Radio error (${err.status}).`;
  }
  return 'The transcript did not come back in time.';
}

function copilotError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return `The copilot runs on the ORION backend, which isn't reachable at ${ORION_CONFIG.apiBase}. Start the backend (with internet and GEMINI_API_KEY) to ask questions.`;
    }
    if (typeof err.error?.detail === 'string') return err.error.detail;
    return `Copilot error (${err.status}).`;
  }
  return 'Copilot error.';
}
