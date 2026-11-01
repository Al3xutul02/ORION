import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { AarLog } from '../../components/aar-log/aar-log';
import { CopilotPanel } from '../../components/copilot-panel/copilot-panel';
import { DecisionPanel } from '../../components/decision-panel/decision-panel';
import { FleetPanel } from '../../components/fleet-panel/fleet-panel';
import { RadioPanel } from '../../components/radio-panel/radio-panel';
import { TheatreMap } from '../../components/theatre-map/theatre-map';

/**
 * Panel sizes the operator can drag (px); the map and the log take what's left. On a screen too
 * small for the saved sizes, panels give way down to their minimum before the map and log do.
 */
type Size = 'fleet' | 'decisions' | 'bottom' | 'radio' | 'copilot';

const DEFAULTS: Record<Size, number> = { fleet: 320, decisions: 360, bottom: 250, radio: 320, copilot: 380 };
const LIMITS: Record<Size, [number, number]> = {
  fleet: [220, 560],
  decisions: [280, 620],
  bottom: [150, 640],
  radio: [220, 640],
  copilot: [260, 760],
};
/** What must stay visible while dragging: the map and the log never shrink below this. */
const MIN_MAP_W = 320;
const MIN_MAP_H = 220;
const MIN_LOG_W = 360;
const GUTTER = 10;
const STORAGE_KEY = 'orion.layout';

@Component({
  selector: 'app-dashboard',
  imports: [FleetPanel, TheatreMap, DecisionPanel, AarLog, RadioPanel, CopilotPanel],
  host: {
    '[style.--fleet-w.px]': 'size().fleet',
    '[style.--decisions-w.px]': 'size().decisions',
    '[style.--bottom-h.px]': 'size().bottom',
    '[style.--radio-w.px]': 'size().radio',
    '[style.--copilot-w.px]': 'size().copilot',
    '[class.dragging]': 'dragging() !== null',
  },
  template: `
    <app-fleet-panel class="fleet" />
    <div class="gutter col g-fleet" [class.on]="dragging() === 'fleet'" (pointerdown)="startDrag($event, 'fleet')" (dblclick)="reset('fleet')" title="Trage ca să redimensionezi · dublu-click: mărimea inițială"></div>
    <app-theatre-map class="map" />
    <div class="gutter col g-decisions" [class.on]="dragging() === 'decisions'" (pointerdown)="startDrag($event, 'decisions')" (dblclick)="reset('decisions')" title="Trage ca să redimensionezi · dublu-click: mărimea inițială"></div>
    <app-decision-panel class="decisions" />
    <div class="gutter row g-bottom" [class.on]="dragging() === 'bottom'" (pointerdown)="startDrag($event, 'bottom')" (dblclick)="reset('bottom')" title="Trage ca să redimensionezi · dublu-click: mărimea inițială"></div>
    <div class="bottom">
      <app-aar-log />
      <div class="gutter col" [class.on]="dragging() === 'radio'" (pointerdown)="startDrag($event, 'radio')" (dblclick)="reset('radio')" title="Trage ca să redimensionezi · dublu-click: mărimea inițială"></div>
      <app-radio-panel />
      <div class="gutter col" [class.on]="dragging() === 'copilot'" (pointerdown)="startDrag($event, 'copilot')" (dblclick)="reset('copilot')" title="Trage ca să redimensionezi · dublu-click: mărimea inițială"></div>
      <app-copilot-panel />
    </div>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(${LIMITS.fleet[0]}px, var(--fleet-w)) ${GUTTER}px minmax(${MIN_MAP_W}px, 1fr) ${GUTTER}px minmax(${LIMITS.decisions[0]}px, var(--decisions-w));
      grid-template-rows: minmax(0, 1fr) ${GUTTER}px var(--bottom-h);
      grid-template-areas:
        'fleet g-fleet map g-decisions decisions'
        'g-bottom g-bottom g-bottom g-decisions decisions'
        'bottom bottom bottom g-decisions decisions';
      padding: 10px;
      height: 100%;
      min-height: 540px;
      box-sizing: border-box;
    }
    :host.dragging { user-select: none; }
    .fleet { grid-area: fleet; min-height: 0; }
    .map { grid-area: map; min-height: 0; }
    .decisions { grid-area: decisions; min-height: 0; }
    .g-fleet { grid-area: g-fleet; }
    .g-decisions { grid-area: g-decisions; }
    .g-bottom { grid-area: g-bottom; }
    .bottom {
      grid-area: bottom;
      display: grid;
      grid-template-columns: minmax(${MIN_LOG_W}px, 1fr) ${GUTTER}px minmax(${LIMITS.radio[0]}px, var(--radio-w)) ${GUTTER}px minmax(${LIMITS.copilot[0]}px, var(--copilot-w));
      min-height: 0;
      position: relative;
      z-index: 2;
    }

    /* A divider: an invisible strip in the gap, with a line that shows on hover and while dragging. */
    .gutter {
      position: relative;
      touch-action: none;
      z-index: 3;
    }
    .gutter::after {
      content: '';
      position: absolute;
      border-radius: 2px;
      background: var(--accent);
      opacity: 0;
      transition: opacity 0.15s;
    }
    .gutter:hover::after, .gutter.on::after { opacity: 0.7; }
    .gutter.col { cursor: col-resize; }
    .gutter.col::after { top: 25%; bottom: 25%; left: 50%; width: 3px; margin-left: -1.5px; }
    .gutter.row { cursor: row-resize; }
    .gutter.row::after { left: 25%; right: 25%; top: 50%; height: 3px; margin-top: -1.5px; }

    @media (max-width: 1200px) {
      :host {
        grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
        grid-template-rows: 520px auto 300px;
        grid-template-areas:
          'fleet map'
          'decisions decisions'
          'bottom bottom';
        gap: 10px;
        height: auto;
      }
      .gutter { display: none; }
      .bottom {
        grid-template-columns: minmax(0, 1fr) minmax(260px, 330px) minmax(300px, 400px);
        gap: 10px;
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
        grid-template-rows: 300px 300px 380px;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected size = signal<Record<Size, number>>(loadSizes());
  protected dragging = signal<Size | null>(null);

  /** Drag a divider: the panel on its far side grows or shrinks, within limits that keep the map and log usable. */
  protected startDrag(ev: PointerEvent, which: Size): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const gutter = ev.currentTarget as HTMLElement;
    gutter.setPointerCapture(ev.pointerId);
    const start = { x: ev.clientX, y: ev.clientY, value: this.size()[which] };
    const box = this.host.nativeElement.getBoundingClientRect();
    const bottomBox = this.host.nativeElement.querySelector('.bottom')!.getBoundingClientRect();
    this.dragging.set(which);

    const move = (e: PointerEvent) => {
      const s = this.size();
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      // Left-hand panels grow with the pointer; right-hand and bottom ones grow against it.
      const raw = which === 'fleet' ? start.value + dx : which === 'bottom' ? start.value - dy : start.value - dx;
      const room = {
        fleet: box.width - 20 - s.decisions - 2 * GUTTER - MIN_MAP_W,
        decisions: box.width - 20 - s.fleet - 2 * GUTTER - MIN_MAP_W,
        bottom: box.height - 20 - GUTTER - MIN_MAP_H,
        radio: bottomBox.width - s.copilot - 2 * GUTTER - MIN_LOG_W,
        copilot: bottomBox.width - s.radio - 2 * GUTTER - MIN_LOG_W,
      }[which];
      const [lo, hi] = LIMITS[which];
      const value = Math.round(Math.max(lo, Math.min(hi, room, raw)));
      if (value !== s[which]) this.size.set({ ...s, [which]: value });
    };
    const end = () => {
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', end);
      gutter.removeEventListener('pointercancel', end);
      this.dragging.set(null);
      saveSizes(this.size());
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', end);
    gutter.addEventListener('pointercancel', end);
  }

  protected reset(which: Size): void {
    this.size.update(s => ({ ...s, [which]: DEFAULTS[which] }));
    saveSizes(this.size());
  }
}

function loadSizes(): Record<Size, number> {
  const out = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Record<Size, unknown>>;
    for (const k of Object.keys(DEFAULTS) as Size[]) {
      const v = saved[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], v));
    }
  } catch { /* storage unavailable or corrupt: defaults */ }
  return out;
}

function saveSizes(s: Record<Size, number>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
