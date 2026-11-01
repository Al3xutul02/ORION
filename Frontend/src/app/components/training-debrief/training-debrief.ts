import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { OrionStore } from '../../core/orion-store.service';
import { DecisionRecord, MOVE_LABELS, TARGET_REACTION_S, actionRo } from '../../core/training';

/** The scored debrief at the end of an AI training session (core/training.ts). */
@Component({
  selector: 'app-training-debrief',
  imports: [DecimalPipe],
  templateUrl: './training-debrief.html',
  styleUrl: './training-debrief.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingDebrief {
  protected store = inject(OrionStore);
  protected session = computed(() => {
    const t = this.store.training();
    return t && t.phase !== 'running' ? t : null;
  });
  protected readonly target = TARGET_REACTION_S;
  protected readonly moveLabel = MOVE_LABELS;
  protected readonly actionRo = actionRo;

  protected outcome(d: DecisionRecord): string {
    return { APPROVED: 'Aprobat', REJECTED: 'Respins', OVERRIDDEN: 'Altă comandă', MISSED: 'Ratat' }[d.outcome];
  }

  protected speed(d: DecisionRecord): 'ok' | 'slow' | 'missed' {
    if (d.reactionS === null) return 'missed';
    return d.reactionS <= TARGET_REACTION_S ? 'ok' : 'slow';
  }

  protected scoreClass(score: number): string {
    return score >= 85 ? 'ok' : score >= 50 ? 'mid' : 'bad';
  }
}
