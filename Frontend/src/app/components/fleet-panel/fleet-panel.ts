import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { DroneState } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';

interface Signal {
  key: string;
  label: string;
  value: number;
}

@Component({
  selector: 'app-fleet-panel',
  imports: [DecimalPipe],
  templateUrl: './fleet-panel.html',
  styleUrl: './fleet-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FleetPanel {
  protected store = inject(OrionStore);

  protected deployDrone(): void {
    this.store.deployDrone();
  }

  protected signals(d: DroneState): Signal[] {
    const s = d.scores;
    if (!s) return [];
    return [
      { key: 'gps', label: 'GPS', value: s.gps_score },
      { key: 'imu', label: 'INS', value: s.imu_score },
      { key: 'link', label: 'Link', value: s.link_score },
      { key: 'consensus', label: 'Peers', value: s.consensus_score },
    ];
  }

  protected level(v: number): string {
    return v >= 75 ? 'GREEN' : v >= 40 ? 'YELLOW' : 'RED';
  }

  protected sparkline(id: number): string {
    const h = this.store.trustHistory()[id] ?? [];
    if (h.length < 2) return '';
    const w = 100, ht = 24;
    return h.map((v, i) => `${((i / (h.length - 1)) * w).toFixed(1)},${(ht - (v / 100) * ht).toFixed(1)}`).join(' ');
  }

  protected reasons(d: DroneState): string[] {
    return d.reason.split(';').map(r => r.trim()).filter(Boolean);
  }
}
