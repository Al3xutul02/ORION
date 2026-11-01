import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { OrionStore } from '../../core/orion-store.service';
import { KIND_LABELS, RadioEntry, RadioKind, contextIds, missionClock } from '../../core/radio';

/** The radio net as a chat: every transmission in order, filterable by drone and kind. */
@Component({
  selector: 'app-radio-panel',
  templateUrl: './radio-panel.html',
  styleUrl: './radio-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RadioPanel {
  protected store = inject(OrionStore);
  protected droneFilter = signal<number | null>(null);
  protected kindFilter = signal<RadioKind | null>(null);
  protected readonly kindLabels = KIND_LABELS;
  protected readonly clock = missionClock;
  private list = viewChild<ElementRef<HTMLDivElement>>('list');

  protected drones = computed(() => [...new Set(this.store.radioEntries().flatMap(e => e.drones))].sort((a, b) => a - b));
  protected kinds = computed(() => {
    const present = new Set(this.store.radioEntries().map(e => e.kind));
    return (Object.keys(KIND_LABELS) as RadioKind[]).filter(k => present.has(k));
  });
  protected shown = computed(() => {
    const d = this.droneFilter();
    const k = this.kindFilter();
    return this.store.radioEntries().filter(e => (d === null || e.drones.includes(d)) && (k === null || e.kind === k));
  });

  constructor() {
    // Newest at the bottom, like a chat: follow it unless the operator scrolled up to read.
    let count = 0;
    effect(() => {
      const n = this.shown().length;
      const el = this.list()?.nativeElement;
      if (!el || n === count) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40 || n < count;
      count = n;
      if (atBottom) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected toggleDrone(d: number): void {
    this.droneFilter.update(x => (x === d ? null : d));
  }

  protected toggleKind(k: RadioKind): void {
    this.kindFilter.update(x => (x === k ? null : k));
  }

  /** Show the transmission and what the system logged around it in the after-action log. */
  protected jump(e: RadioEntry): void {
    this.store.highlightEvents(contextIds(this.store.events(), e));
  }

  protected selectDrone(ev: Event, d: number): void {
    ev.stopPropagation();
    this.store.selectDrone(d);
  }

  protected isActive(e: RadioEntry): boolean {
    return this.store.highlightedEvents()[0] === e.id;
  }
}
