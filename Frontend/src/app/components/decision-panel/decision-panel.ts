import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { evaluateActions } from '../../core/geo';
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

  protected actions = computed(() => {
    const d = this.store.selectedDrone();
    return d ? evaluateActions(d, this.store.zones()) : [];
  });

  protected history = computed(() => this.store.recommendations().filter(r => r.status !== 'PENDING'));

  protected steps(rec: Recommendation): string[] {
    const text = rec.recommendation_details ?? '';
    const parts = text.split(/\s*\d+\.\s+/).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : [text];
  }

  protected pretty(action: string): string {
    return action.replaceAll('_', ' ').toLowerCase();
  }
}
