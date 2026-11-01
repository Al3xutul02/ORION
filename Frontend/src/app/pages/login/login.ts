import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OrionStore } from '../../core/orion-store.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppLogin {
  protected store = inject(OrionStore);

  protected username = signal('');
  protected password = signal('');
  protected errorMessage = signal<string | null>(null);
  protected isAuthenticating = signal(false);

  protected async onSubmit(): Promise<void> {
    const u = this.username().trim();
    const p = this.password().trim();
    if (!u || !p) {
      this.errorMessage.set('Please enter both username and password.');
      return;
    }

    this.errorMessage.set(null);
    this.isAuthenticating.set(true);

    try {
      const res = await this.store.login(u, p);
      if (!res.ok) {
        this.errorMessage.set(res.message || 'Authentication failed. Please verify credentials.');
      }
    } finally {
      this.isAuthenticating.set(false);
    }
  }

  protected selectDemoUser(user: 'operator_demo' | 'commander_demo'): void {
    this.username.set(user);
    this.password.set('123');
    this.errorMessage.set(null);
    void this.onSubmit();
  }
}
