import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuditEvent } from '../../core/models';
import { OrionStore, summarise } from '../../core/orion-store.service';

const SEVERITY: Record<string, 'critical' | 'warn' | 'ok' | 'info'> = {
  SPOOFING_ATTACK_INITIATED: 'critical',
  COMMAND_REPLAY_REJECTED: 'critical',
  COMMAND_AUTH_FAILED: 'critical',
  RECOMMENDATION_ISSUED: 'warn',
  ZONE_INTERFERENCE_MARKED: 'warn',
  OPERATOR_REJECTION: 'warn',
  OPERATOR_APPROVAL: 'ok',
  COMMAND_EXECUTED: 'ok',
  DRONE_RECOVERED: 'ok',
};

@Component({
  selector: 'app-aar-log',
  imports: [DatePipe, RouterLink],
  templateUrl: './aar-log.html',
  styleUrl: './aar-log.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AarLog {
  protected store = inject(OrionStore);
  protected verifying = signal(false);

  protected rows = computed(() => [...this.store.events()].reverse());

  protected severity(e: AuditEvent): string {
    return SEVERITY[e.event_type] ?? 'info';
  }

  protected summary(e: AuditEvent): string {
    return summarise(e);
  }

  protected short(hash: string): string {
    return hash.slice(0, 8);
  }

  protected isBroken(e: AuditEvent): boolean {
    const v = this.store.verification();
    if (!v || v.is_valid || v.broken_at_index === null) return false;
    return this.store.events()[v.broken_at_index]?.id === e.id;
  }

  protected async verify(): Promise<void> {
    this.verifying.set(true);
    await this.store.verify();
    this.verifying.set(false);
  }
}
