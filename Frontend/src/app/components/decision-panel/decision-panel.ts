import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActionOption, evaluateActions } from '../../core/geo';
import { Recommendation } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';

export type DecisionTab = 'commands' | 'suggestions';

@Component({
  selector: 'app-decision-panel',
  imports: [DatePipe],
  templateUrl: './decision-panel.html',
  styleUrl: './decision-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DecisionPanel {
  protected store = inject(OrionStore);

  /** Active sub-tab: 'commands' (default) or 'suggestions'. */
  protected activeTab = signal<DecisionTab>('commands');

  /** Action awaiting the operator's second click in the Commands tab. */
  protected confirming = signal<ActionOption['id'] | null>(null);

  protected actions = computed(() => {
    const d = this.store.selectedDrone();
    return d ? evaluateActions(d, this.store.zones()) : [];
  });

  protected canCommand = computed(() => this.store.mode() === 'offline' || this.store.link() === 'online');

  protected history = computed(() => this.store.recommendations().filter(r => r.status !== 'PENDING'));

  private prevPendingCount = 0;

  constructor() {
    // Switching drones cancels a half-finished confirmation.
    effect(() => {
      this.store.selectedDroneId();
      this.confirming.set(null);
    });

    // When new recommendations arrive, bring them to the operator's attention
    effect(() => {
      const pending = this.store.pendingRecommendations();
      if (pending.length > this.prevPendingCount && this.confirming() === null) {
        this.activeTab.set('suggestions');
      }
      this.prevPendingCount = pending.length;
    });
  }

  protected setTab(tab: DecisionTab): void {
    this.activeTab.set(tab);
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
    if (rec.trigger_event === 'SENSORS_RECALIBRATED_SAFE' || rec.recommended_action === 'CONTINUE_PATROL') {
      return 'Sensor recalibration complete and verified in clean airspace. Action needed: Drone is holding idle in loiter; operator command is required to resume regular sector patrol.';
    }
    if (rec.trigger_event === 'SPOOFING_ATTACK_DETECTED' || rec.recommended_action === 'LOITER') {
      return 'Adversary GPS spoofing detected (sudden ephemeris jump). Action needed: Continuing patrol with corrupted GPS coordinates will drive the drone off course into danger; immediate LOITER is required to hold position and stabilize onboard EKF/IMU.';
    }
    if (rec.recommended_action.includes('CORRIDOR')) {
      return rec.blocked_reason
        ? `Hostile electronic warfare hazard active (${rec.blocked_reason}). Action needed: Direct flight path is compromised; drone must divert through Safe Corridor to prevent complete C2 link loss.`
        : 'Hostile interference active in sector. Action needed: Drone must divert through verified Safe Corridor to maintain link.';
    }
    if (rec.recommended_action === 'SAFE_ROUTE_RETREAT') {
      return `Direct path to Base is blocked (${rec.blocked_reason || 'hazard zone'}). Action needed: Drone must navigate around threats via computed A* safe waypoints to reach Base.`;
    }
    if (rec.recommended_action === 'RETURN_TO_HOME') {
      return 'Sensor confidence degraded or operating limits exceeded. Action needed: Return-to-base along clear corridor is required to protect the airframe.';
    }
    return rec.blocked_reason
      ? `Operating hazard detected: ${rec.blocked_reason}. Action needed: Tactical intervention required to safeguard the airframe.`
      : 'Action needed: Tactical safety procedure required by ORION rules engine.';
  }
}
