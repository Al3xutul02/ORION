import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { AuditEvent, ExportReport } from '../../core/models';
import { OrionStore, parseDetails, summarise } from '../../core/orion-store.service';

const DECISION_TYPES = new Set([
  'RECOMMENDATION_ISSUED',
  'RECOMMENDATION_SUPERSEDED',
  'OPERATOR_APPROVAL',
  'OPERATOR_REJECTION',
  'OPERATOR_COMMAND',
  'FAILSAFE_APPLIED',
  'ROUTE_REPLANNED',
  'COMMAND_EXECUTED',
  'SAFE_CORRIDOR_ESTABLISHED',
  'THREAT_ZONE_CLEARED',
]);
const ATTACK_TYPES = new Set([
  'SPOOFING_ATTACK_INITIATED',
  'COMMAND_REPLAY_REJECTED',
  'COMMAND_AUTH_FAILED',
  'EW_EMITTER_ACTIVE',
  'ZONE_INTERFERENCE_MARKED',
  'COMMAND_LINK_LOST',
  'THREAT_ZONE_DETECTED',
  'SAFE_CORRIDOR_COMPROMISED',
]);

@Component({
  selector: 'app-report',
  imports: [DatePipe, JsonPipe],
  templateUrl: './report.html',
  styleUrl: './report.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Report {
  protected store = inject(OrionStore);
  protected report = signal<ExportReport | null>(null);
  protected loading = signal(false);
  protected expanded = signal<number | null>(null);

  protected attacks = computed(() => this.report()?.timeline.filter(e => ATTACK_TYPES.has(e.event_type)) ?? []);
  protected decisions = computed(() => this.report()?.timeline.filter(e => DECISION_TYPES.has(e.event_type)) ?? []);
  protected approvers = computed(() => [
    ...new Set(
      (this.report()?.timeline ?? [])
        .filter(e => e.event_type === 'OPERATOR_APPROVAL' || e.event_type === 'OPERATOR_REJECTION')
        .map(e => e.operator_id),
    ),
  ]);

  constructor() {
    this.generate();
  }

  protected async generate(): Promise<void> {
    this.loading.set(true);
    const r = await this.store.buildReport();
    this.report.set(r);
    if (r) this.store.verification.set(r.verification);
    this.loading.set(false);
  }

  protected summary(e: AuditEvent): string {
    return summarise(e);
  }

  protected details(e: AuditEvent) {
    return parseDetails(e);
  }

  protected toggle(id: number): void {
    this.expanded.update(cur => (cur === id ? null : id));
  }

  protected download(): void {
    const r = this.report();
    if (!r) return;
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.mission_id}-aar-${new Date().toISOString().slice(0, 19).replaceAll(':', '')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  protected print(): void {
    window.print();
  }
}
