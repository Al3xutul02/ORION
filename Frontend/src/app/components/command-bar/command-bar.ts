import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ORION_CONFIG } from '../../core/config';
import { OrionStore } from '../../core/orion-store.service';
import { MOVE_LABELS } from '../../core/training';

@Component({
  selector: 'app-command-bar',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './command-bar.html',
  styleUrl: './command-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandBar {
  protected store = inject(OrionStore);
  protected readonly moveLabels = MOVE_LABELS;
  protected apiBase = ORION_CONFIG.apiBase;
  protected speeds = [1, 2, 4];

  protected clock = computed(() => {
    const t = Math.max(0, Math.floor(this.store.elapsed()));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  });

  protected trainingRemaining = computed(() => {
    const t = this.store.training();
    if (!t) return '';
    const left = Math.max(0, Math.ceil(t.lengthS - (this.store.elapsed() - t.startedAt)));
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  });

  /** How far the AI-training session is, 0-100. */
  protected progress = computed(() => {
    const t = this.store.training();
    return t ? Math.min(100, ((this.store.elapsed() - t.startedAt) / t.lengthS) * 100) : 0;
  });

  protected movePos(atS: number): number {
    const t = this.store.training();
    return t ? Math.min(100, (atS / t.lengthS) * 100) : 0;
  }

  protected liveTheatreSummary = computed(() => {
    const zs = this.store.zones();
    const corridors = zs.filter(z => z.zone_type === 'SAFE_CORRIDOR').length;
    const hazards = zs.filter(z => z.zone_type === 'THREAT' || z.zone_type === 'INTERFERENCE').length;
    return `${corridors} safe corridor${corridors === 1 ? '' : 's'} · ${hazards} danger/EW zone${hazards === 1 ? '' : 's'}`;
  });

  protected onIntervalMinChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      this.store.setRandomInterval(val, Math.max(val, this.store.randomIntervalMax()));
    } else {
      input.value = String(this.store.randomIntervalMin());
    }
  }

  protected onIntervalMaxChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      this.store.setRandomInterval(Math.min(this.store.randomIntervalMin(), val), val);
    } else {
      input.value = String(this.store.randomIntervalMax());
    }
  }
}
