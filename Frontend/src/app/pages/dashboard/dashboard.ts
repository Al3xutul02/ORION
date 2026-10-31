import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AarLog } from '../../components/aar-log/aar-log';
import { CopilotPanel } from '../../components/copilot-panel/copilot-panel';
import { DecisionPanel } from '../../components/decision-panel/decision-panel';
import { FleetPanel } from '../../components/fleet-panel/fleet-panel';
import { TheatreMap } from '../../components/theatre-map/theatre-map';

@Component({
  selector: 'app-dashboard',
  imports: [FleetPanel, TheatreMap, DecisionPanel, AarLog, CopilotPanel],
  template: `
    <app-fleet-panel class="fleet" />
    <app-theatre-map class="map" />
    <app-decision-panel class="decisions" />
    <div class="bottom">
      <app-aar-log />
      <app-copilot-panel />
    </div>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(280px, 330px) minmax(0, 1fr) minmax(300px, 360px);
      grid-template-rows: minmax(280px, 1fr) minmax(220px, 260px);
      grid-template-areas:
        'fleet map decisions'
        'bottom bottom decisions';
      gap: 10px;
      padding: 10px;
      height: 100%;
      min-height: 540px;
      box-sizing: border-box;
    }
    .fleet { grid-area: fleet; min-height: 0; }
    .map { grid-area: map; min-height: 0; }
    .decisions { grid-area: decisions; min-height: 0; }
    .bottom {
      grid-area: bottom;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 400px);
      gap: 10px;
      min-height: 0;
      position: relative;
      z-index: 2;
    }

    @media (max-width: 1200px) {
      :host {
        grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
        grid-template-rows: 520px auto 300px;
        grid-template-areas:
          'fleet map'
          'decisions decisions'
          'bottom bottom';
        height: auto;
      }
    }

    @media (max-width: 760px) {
      :host {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: 420px auto auto auto;
        grid-template-areas: 'map' 'fleet' 'decisions' 'bottom';
      }
      .bottom {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: 300px 380px;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {}
