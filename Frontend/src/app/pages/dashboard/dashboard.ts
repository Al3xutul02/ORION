import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AarLog } from '../../components/aar-log/aar-log';
import { DecisionPanel } from '../../components/decision-panel/decision-panel';
import { FleetPanel } from '../../components/fleet-panel/fleet-panel';
import { TheatreMap } from '../../components/theatre-map/theatre-map';

@Component({
  selector: 'app-dashboard',
  imports: [FleetPanel, TheatreMap, DecisionPanel, AarLog],
  template: `
    <app-fleet-panel class="fleet" />
    <app-theatre-map class="map" />
    <app-decision-panel class="decisions" />
    <app-aar-log class="log" />
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(280px, 330px) minmax(0, 1fr) minmax(300px, 360px);
      grid-template-rows: minmax(0, 1fr) 230px;
      grid-template-areas:
        'fleet map decisions'
        'log   log decisions';
      gap: 10px;
      padding: 10px;
      height: 100%;
      min-height: 0;
    }
    .fleet { grid-area: fleet; }
    .map { grid-area: map; }
    .decisions { grid-area: decisions; }
    .log { grid-area: log; }

    @media (max-width: 1200px) {
      :host {
        grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
        grid-template-rows: 520px auto 260px;
        grid-template-areas:
          'fleet map'
          'decisions decisions'
          'log log';
        height: auto;
      }
    }

    @media (max-width: 760px) {
      :host {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: 420px auto auto 300px;
        grid-template-areas: 'map' 'fleet' 'decisions' 'log';
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {}
