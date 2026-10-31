import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ORION_CONFIG } from './config';
import { AuditEvent, ChainVerification, CopilotAnswer, DecisionResult, ExportReport, Recommendation } from './models';

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
  | 'trigger-danger-disappear';

/** REST client for the FastAPI backend (Backend/app/api/endpoints). */
@Injectable({ providedIn: 'root' })
export class OrionApi {
  private http = inject(HttpClient);
  private base = ORION_CONFIG.apiV1;

  health() {
    return firstValueFrom(this.http.get<{ status: string; simulator_running: boolean; simulation_time_s: number }>(`${ORION_CONFIG.apiBase}/health`));
  }

  events(limit = 500) {
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

  command(droneId: number, action: string, notes?: string) {
    return firstValueFrom(
      this.http.post<DecisionResult>(`${this.base}/actions/command`, {
        drone_id: droneId,
        action,
        operator_id: ORION_CONFIG.operatorId,
        notes,
      }),
    );
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
