import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ORION_CONFIG } from '../../core/config';
import { SCENARIO_EXTENDED } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';

const DEMO_LENGTH_S = 180;

@Component({
  selector: 'app-command-bar',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './command-bar.html',
  styleUrl: './command-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandBar {
  protected store = inject(OrionStore);
  protected scenario = computed(() => SCENARIO_EXTENDED);
  protected apiBase = ORION_CONFIG.apiBase;
  protected speeds = [1, 2, 4];

  protected clock = computed(() => {
    const t = Math.max(0, Math.floor(this.store.elapsed()));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  });

  protected progress = computed(() => Math.min(100, (this.store.elapsed() / DEMO_LENGTH_S) * 100));

  protected stepPos(at: number): number {
    return (at / DEMO_LENGTH_S) * 100;
  }

  protected currentStep = computed(() => {
    const t = this.store.elapsed();
    const steps = this.scenario();
    return [...steps].reverse().find(s => t >= s.at) ?? steps[0];
  });

  protected liveTheatreSummary = computed(() => {
    const zs = this.store.zones();
    const corridors = zs.filter(z => z.zone_type === 'SAFE_CORRIDOR').length;
    const hazards = zs.filter(z => z.zone_type === 'THREAT' || z.zone_type === 'INTERFERENCE').length;
    return `${corridors} safe corridor${corridors === 1 ? '' : 's'} · ${hazards} danger/EW zone${hazards === 1 ? '' : 's'}`;
  });
}
