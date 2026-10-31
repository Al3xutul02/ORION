import { Routes } from '@angular/router';
import { Dashboard } from './pages/dashboard/dashboard';

export const routes: Routes = [
  { path: '', component: Dashboard, title: 'ORION · Operations' },
  { path: 'report', loadComponent: () => import('./pages/report/report').then(m => m.Report), title: 'ORION · Post-action report' },
  { path: '**', redirectTo: '' },
];
