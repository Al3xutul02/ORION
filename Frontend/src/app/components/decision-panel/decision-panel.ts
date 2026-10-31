import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActionOption, evaluateActions } from '../../core/geo';
import { Recommendation } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';

@Component({
  selector: 'app-decision-panel',
  imports: [DatePipe],
  templateUrl: './decision-panel.html',
  styleUrl: './decision-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DecisionPanel {
  protected store = inject(OrionStore);

  /** Action awaiting the operator's second click. */
  protected confirming = signal<ActionOption['id'] | null>(null);

  protected actions = computed(() => {
    const d = this.store.selectedDrone();
    return d ? evaluateActions(d, this.store.zones()) : [];
  });

  protected canCommand = computed(() => this.store.mode() === 'offline' || this.store.link() === 'online');

  protected history = computed(() => this.store.recommendations().filter(r => r.status !== 'PENDING'));

  constructor() {
    // Switching drones cancels a half-finished confirmation.
    effect(() => {
      this.store.selectedDroneId();
      this.confirming.set(null);
    });
  }

  protected send(a: ActionOption): void {
    const d = this.store.selectedDrone();
    if (!d) return;
    this.store.commandDrone(d.drone_id, a.id);
    this.confirming.set(null);
  }

  protected steps(rec: Recommendation): string[] {
    const text = rec.recommendation_details ?? '';
    const parts = text.split(/\s*\d+\.\s+/).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : [text];
  }

  protected pretty(action: string): string {
    return action.replaceAll('_', ' ').toLowerCase();
  }

  protected recReason(rec: Recommendation): string {
    if (rec.reason) return rec.reason;
    if (rec.trigger_event === 'SENSORS_RECALIBRATED_SAFE') {
      return 'Sensors recalibrated and clean GPS fix verified; safe to resume regular sector patrol.';
    }
    if (rec.recommended_action === 'CONTINUE_PATROL') {
      return 'Sensors and navigation verified nominal in safe airspace; clear to resume patrol orbit.';
    }
    if (rec.recommended_action.includes('CORRIDOR')) {
      return rec.blocked_reason
        ? `Direct route compromised (${rec.blocked_reason}); verified corridor provides safe egress.`
        : 'Safe corridor provides clear passage away from battlefield interference.';
    }
    if (rec.recommended_action === 'SAFE_ROUTE_RETREAT') {
      return 'Direct RTL path is blocked; computed A* route skirts active hazard boundaries safely.';
    }
    if (rec.recommended_action === 'LOITER') {
      return 'Sudden GPS ephemeris jump detected; holding position allows onboard EKF/IMU to stabilize and reject false fix.';
    }
    if (rec.recommended_action === 'RETURN_TO_HOME') {
      return 'Direct flight corridor to Home Base is verified clear of known EW hazards and severe weather.';
    }
    return rec.blocked_reason || 'Tactical safety procedure recommended by ORION rules engine.';
  }
}
