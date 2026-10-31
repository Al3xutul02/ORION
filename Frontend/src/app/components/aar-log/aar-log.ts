import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuditEvent } from '../../core/models';
import { OrionStore, summarise } from '../../core/orion-store.service';

const SEVERITY: Record<string, 'critical' | 'warn' | 'ok' | 'info' | 'radio'> = {
  SPOOFING_ATTACK_INITIATED: 'critical',
  COMMAND_REPLAY_REJECTED: 'critical',
  COMMAND_AUTH_FAILED: 'critical',
  RECOMMENDATION_ISSUED: 'warn',
  ZONE_INTERFERENCE_MARKED: 'warn',
  SAFE_CORRIDOR_ESTABLISHED: 'ok',
  SAFE_CORRIDOR_COMPROMISED: 'warn',
  THREAT_ZONE_DETECTED: 'critical',
  THREAT_ZONE_CLEARED: 'ok',
  OPERATOR_REJECTION: 'warn',
  OPERATOR_APPROVAL: 'ok',
  COMMAND_EXECUTED: 'ok',
  DRONE_RECOVERED: 'ok',
  ROUTE_REPLANNED: 'warn',
  WEATHER_CELL_DETECTED: 'warn',
  WEATHER_LIMIT_EXCEEDED: 'critical',
  WEATHER_CLEARED: 'ok',
  COMMAND_LINK_LOST: 'critical',
  EW_EMITTER_ACTIVE: 'critical',
  GPS_DEGRADED_SINGLE: 'warn',
  FAILSAFE_APPLIED: 'warn',
  COMMAND_UNDELIVERABLE: 'warn',
  RECOMMENDATION_SUPERSEDED: 'warn',
  OPERATOR_COMMAND: 'ok',
  GPS_RESTORED: 'ok',
  COMMAND_LINK_RESTORED: 'ok',
  PATROL_REBALANCED: 'info',
  RADIO_TRANSMISSION: 'radio',
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
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Bring the first record the copilot cited into view.
    effect(() => {
      const ids = this.store.highlightedEvents();
      if (!ids.length) return;
      queueMicrotask(() => {
        const rows = [...this.host.nativeElement.querySelectorAll<HTMLElement>('[data-event-id]')];
        const first = rows.find(r => Number(r.dataset['eventId']) === ids[0]) ?? rows.find(r => ids.includes(Number(r.dataset['eventId'])));
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
  }

  protected isCited(e: AuditEvent): boolean {
    return this.store.highlightedEvents().includes(e.id);
  }

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
