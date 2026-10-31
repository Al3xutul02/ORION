import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ORION_CONFIG } from './config';
import { AuditEvent, Zone, ChainVerification, CopilotAnswer, DecisionResult, ExportReport, Recommendation } from './models';

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

  decide(recommendationId: number, decision: 'APPROVE' | 'REJECT', notes?: string) {
    return firstValueFrom(
      this.http.post<DecisionResult>(`${this.base}/actions/decide`, {
        recommendation_id: recommendationId,
        operator_id: ORION_CONFIG.operatorId,
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
  ) {
    return firstValueFrom(
      this.http.post<DecisionResult>(`${this.base}/actions/command`, {
        drone_id: droneId,
        action,
        operator_id: ORION_CONFIG.operatorId,
        notes,
        target_zone_id: targetZoneId,
        target_point: targetPoint,
        path_type: pathType,
      }),
    );
  }

  createPatrolZone(body: { name?: string; center: [number, number]; radius_m: number }) {
    return firstValueFrom(this.http.post<Zone>(`${this.base}/zones/patrol`, body));
  }

  createThreatZone(body: { name?: string; center: [number, number]; radius_m: number }) {
    return firstValueFrom(this.http.post<Zone>(`${this.base}/zones/threat`, body));
  }

  createSafeCorridor(body: { name?: string; waypoints: [number, number][] }) {
    return firstValueFrom(this.http.post<Zone>(`${this.base}/zones/corridor`, body));
  }

  executeZoneTactic(body: { zone_id: number; tactic: string }) {
    return firstValueFrom(this.http.post<{ status: string; zone_id: number; tactic: string }>(`${this.base}/zones/tactic`, body));
  }

  deleteZone(zoneId: number) {
    return firstValueFrom(this.http.delete<{ status: string; id: number }>(`${this.base}/zones/${zoneId}`));
  }

  setRandomInterval(min_s: number, max_s: number) {
    return firstValueFrom(
      this.http.post<{ status: string; random_interval_min: number; random_interval_max: number }>(
        `${this.base}/simulation/config-random-interval`,
        { min_s, max_s },
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

  simulationStatus() {
    return firstValueFrom(
      this.http.get<{ is_running: boolean; elapsed_time: number; milestones: Record<string, boolean> }>(`${this.base}/simulation/status`),
    );
  }
}
