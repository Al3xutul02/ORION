import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Block, parseMarkdown } from '../../core/chat-markdown';
import { CopilotMessage } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';

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
  imports: [NgTemplateOutlet],
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

  private parsed = new WeakMap<CopilotMessage, Block[]>();

  /** The answer's Markdown as blocks with clickable citations; only ids the backend validated become links. */
  protected blocks(m: CopilotMessage): Block[] {
    let b = this.parsed.get(m);
    if (!b) {
      b = parseMarkdown(m.text, new Set(m.citedIds ?? []));
      this.parsed.set(m, b);
    }
    return b;
  }

  protected isHighlighted(id: number): boolean {
    return this.store.highlightedEvents().includes(id);
  }
}
