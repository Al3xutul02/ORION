import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommandBar } from './components/command-bar/command-bar';
import { TrainingDebrief } from './components/training-debrief/training-debrief';
import { OrionStore } from './core/orion-store.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, CommandBar, TrainingDebrief],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected store = inject(OrionStore);

  /** Hold Space to talk on the radio, unless typing or Space would press a focused control. */
  @HostListener('window:keydown', ['$event'])
  protected onKeydown(e: KeyboardEvent): void {
    if (e.code !== 'Space' || isEditable(e.target)) return;
    e.preventDefault();
    if (!e.repeat) void this.store.pttDown();
  }

  @HostListener('window:keyup', ['$event'])
  protected onKeyup(e: KeyboardEvent): void {
    if (e.code === 'Space') this.store.pttUp();
  }

  @HostListener('window:blur')
  protected onBlur(): void {
    this.store.pttUp();
  }
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range'].includes((el as HTMLInputElement).type));
}
