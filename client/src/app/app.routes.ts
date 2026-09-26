import { Routes } from '@angular/router';
import { authGuard } from './utils/auth.guard';
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Observatory',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./fleet/fleet.component').then((m) => m.FleetComponent),
  },
];
