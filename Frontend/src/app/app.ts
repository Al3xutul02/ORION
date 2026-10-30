import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommandBar } from './components/command-bar/command-bar';
import { OrionStore } from './core/orion-store.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, CommandBar],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected store = inject(OrionStore);
}
