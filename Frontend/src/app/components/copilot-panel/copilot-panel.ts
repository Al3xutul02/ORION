import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CopilotMessage } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';

type Segment = { kind: 'text'; text: string } | { kind: 'cite'; id: number } | { kind: 'fleet' };

const SUGGESTIONS = {
  offline: [
    'Why was return-to-home blocked for Drone 2?',
    'What did ORION conclude about the mobile jammer?',
    'What happened to Drone 5 when its link was lost?',
    'Who approved which actions?',
  ],
  live: [
    'Why was return-to-home blocked for Drone 2?',
    'Which attacks were detected, and when?',
    'Who approved which actions?',
    'Rezumă misiunea de până acum.',
  ],
};

@Component({
  selector: 'app-copilot-panel',
  templateUrl: './copilot-panel.html',
  styleUrl: './copilot-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CopilotPanel {
  protected store = inject(OrionStore);
  protected draft = signal('');
  private thread = viewChild<ElementRef<HTMLDivElement>>('thread');

  protected suggestions = computed(() => SUGGESTIONS[this.store.mode()]);

  constructor() {
    // Keep the newest message in view.
    effect(() => {
      this.store.copilot();
      this.store.copilotBusy();
      const el = this.thread()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected send(text = this.draft()): void {
    if (!text.trim() || this.store.copilotBusy()) return;
    this.draft.set('');
    this.store.askCopilot(text);
  }

  protected onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }

  /** Splits an answer into text and clickable citations. Only ids the backend validated become links. */
  protected segments(m: CopilotMessage): Segment[] {
    const valid = new Set(m.citedIds ?? []);
    return m.text.split(/(\[#\d+\]|\[fleet\])/).filter(Boolean).map((part): Segment => {
      const cite = /^\[#(\d+)\]$/.exec(part);
      if (cite && valid.has(Number(cite[1]))) return { kind: 'cite', id: Number(cite[1]) };
      if (part === '[fleet]') return { kind: 'fleet' };
      return { kind: 'text', text: part };
    });
  }

  protected isHighlighted(id: number): boolean {
    return this.store.highlightedEvents().includes(id);
  }
}
