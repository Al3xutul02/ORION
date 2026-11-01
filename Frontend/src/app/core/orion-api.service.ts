import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { ORION_CONFIG } from './config';
import { AppUser, AuditEvent, Zone, ChainVerification, CopilotAnswer, DecisionResult, ExportReport, Recommendation } from './models';
import { AdversaryMoveKind } from './training';

export type SimulationAction =
  | 'start'
  | 'stop'
  | 'reset'
  | 'trigger-random'
  | 'trigger-spoofing'
  | 'trigger-replay'
  | 'trigger-sector-interference'
  | 'trigger-corridor-appear'
  | 'trigger-corridor-disappear'
  | 'trigger-danger-appear'
  | 'trigger-danger-disappear'
  | 'trigger-weather-clear';

/** REST client for the FastAPI backend (Backend/app/api/endpoints). */
@Injectable({ providedIn: 'root' })
export class OrionApi {
  private http = inject(HttpClient);
  private base = ORION_CONFIG.apiV1;

  login(username: string, password: string) {
    return firstValueFrom(
      this.http.post<AppUser>(`${this.base}/auth/login`, { username, password }),
    );
  }

  health() {
    return firstValueFrom(this.http.get<{ status: string; simulator_running: boolean; simulation_time_s: number }>(`${ORION_CONFIG.apiBase}/health`));
  }

  events(limit = 2000) {
    return firstValueFrom(this.http.get<AuditEvent[]>(`${this.base}/aar/events`, { params: { limit } }));
  }

  verify() {
    return firstValueFrom(this.http.get<ChainVerification>(`${this.base}/aar/verify`));
  }

  exportReport(missionId = ORION_CONFIG.missionId) {
    return firstValueFrom(this.http.get<ExportReport>(`${this.base}/aar/export`, { params: { mission_id: missionId } }));
  }

  recommendations(status = 'ALL') {
    return firstValueFrom(this.http.get<Recommendation[]>(`${this.base}/actions/recommendations`, { params: { status } }));
  }

  decide(recommendationId: number, decision: 'APPROVE' | 'REJECT', notes?: string, operatorId: string = ORION_CONFIG.operatorId) {
    return firstValueFrom(
      this.http.post<DecisionResult>(`${this.base}/actions/decide`, {
        recommendation_id: recommendationId,
        operator_id: operatorId,
        decision,
        notes,
      }),
    );
  }

  command(
    droneId: number,
    action: string,
    notes?: string,
    targetZoneId?: number,
    targetPoint?: [number, number],
    pathType: 'SAFE' | 'RISKY' = 'SAFE',
    operatorId: string = ORION_CONFIG.operatorId,
  ) {
    return firstValueFrom(
      this.http.post<DecisionResult>(`${this.base}/actions/command`, {
        drone_id: droneId,
        action,
        operator_id: operatorId,
        notes,
        target_zone_id: targetZoneId,
        target_point: targetPoint,
        path_type: pathType,
      }),
    );
  }

  deployDrone(operatorId: string = ORION_CONFIG.operatorId) {
    return firstValueFrom(this.http.post<{ status: string; drone_id: number; location: number[]; mode: string }>(`${this.base}/drones/deploy`, { operator_id: operatorId }));
  }

  createPatrolZone(body: { name?: string; center: [number, number]; radius_m: number; operator_id?: string }) {
    return firstValueFrom(this.http.post<Zone>(`${this.base}/zones/patrol`, body));
  }

  movePatrolZone(body: { zone_id: number; center: [number, number]; operator_id?: string; path_type?: string }) {
    return firstValueFrom(this.http.post<{ status: string; zone: Zone; drones_count: number; message: string }>(`${this.base}/zones/patrol/move`, body));
  }

  createThreatZone(body: { name?: string; waypoints?: [number, number][]; center?: [number, number]; radius_m?: number; operator_id?: string }) {
    return firstValueFrom(this.http.post<Zone>(`${this.base}/zones/threat`, body));
  }

  createSafeCorridor(body: { name?: string; waypoints: [number, number][]; operator_id?: string }) {
    return firstValueFrom(this.http.post<Zone>(`${this.base}/zones/corridor`, body));
  }

  createObjectiveZone(body: { name?: string; waypoints: [number, number][]; operator_id?: string }) {
    return firstValueFrom(this.http.post<Zone>(`${this.base}/zones/objective`, body));
  }

  executeZoneTactic(body: { zone_id: number; tactic: string; operator_id?: string }) {
    return firstValueFrom(this.http.post<{ status: string; zone_id: number; tactic: string }>(`${this.base}/zones/tactic`, body));
  }

  deleteZone(zoneId: number, operatorId?: string) {
    return firstValueFrom(this.http.delete<{ status: string; id: number }>(`${this.base}/zones/${zoneId}`, { params: operatorId ? { operator_id: operatorId } : {} }));
  }

  setRandomInterval(min_s: number, max_s: number, enabled?: boolean) {
    return firstValueFrom(
      this.http.post<{ status: string; random_interval_min: number; random_interval_max: number; random_events_enabled?: boolean }>(
        `${this.base}/simulation/config-random-interval`,
        { min_s, max_s, enabled },
      ),
    );
  }

  toggleRandomEvents(enabled?: boolean) {
    return firstValueFrom(
      this.http.post<{ status: string; random_events_enabled: boolean }>(
        `${this.base}/simulation/toggle-random-events`,
        enabled !== undefined ? { enabled } : {},
      ),
    );
  }

  weatherAppear(kind: 'STORM' | 'RAIN' | 'WIND') {
    return firstValueFrom(this.http.post<{ status: string }>(`${this.base}/simulation/trigger-weather-appear`, {}, { params: { kind } }));
  }

  simulation(action: SimulationAction) {
    return firstValueFrom(this.http.post<{ status: string }>(`${this.base}/simulation/${action}`, {}));
  }

  copilotAsk(body: {
    question: string;
    history: { role: 'user' | 'assistant'; content: string }[];
    events?: Omit<AuditEvent, 'prev_hash' | 'curr_hash'>[];
    chain_valid?: boolean;
    fleet?: Record<string, unknown>[];
    elapsed_s?: number;
  }) {
    return firstValueFrom(this.http.post<CopilotAnswer>(`${this.base}/copilot/ask`, body));
  }

  /** Gemini as the training adversary. Short timeout: the browser plays locally rather than wait. */
  trainingMove(state: Record<string, unknown>) {
    return firstValueFrom(
      this.http.post<{ move: AdversaryMoveKind; target_drone: number | null; wait_s: number; reason: string; model: string }>(
        `${this.base}/training/adversary-move`, state,
      ).pipe(timeout(12000)),
    );
  }

  trainingDebrief(results: Record<string, unknown>) {
    return firstValueFrom(
      this.http.post<{ summary: string; strengths: string[]; improvements: string[]; model: string }>(
        `${this.base}/training/debrief`, results,
      ).pipe(timeout(30000)),
    );
  }

  /** One push-to-talk transmission: transcribed by Gemini; logged server-side when `log` (Live). */
  radioTransmit(body: {
    audio_base64: string; mime_type: string; duration_s: number; operator_id: string; started_at: string; log: boolean;
  }) {
    return firstValueFrom(
      this.http.post<{ transcript: string; language: string; drones: number[]; kind: string; model: string; logged: boolean; event_id: number | null }>(
        `${this.base}/radio/transmissions`, body,
      ).pipe(timeout(30000)),
    );
  }

  simulationStatus() {
    return firstValueFrom(
      this.http.get<{ is_running: boolean; elapsed_time: number; milestones: Record<string, boolean> }>(`${this.base}/simulation/status`),
    );
  }
}
