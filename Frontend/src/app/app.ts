import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
}
