import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { UserProfileService } from '../user-profile.service';
import { AuthService } from '../auth.service';
@Component({
  selector: 'app-header',
  imports: [MatButtonModule, MatMenuModule],
  template: `
    <button mat-button [matMenuTriggerFor]="menu" aria-label="User profile">
      {{ profile()?.initials }}
    </button>
    <mat-menu #menu="matMenu"
      ><span class="name">{{ profile()?.name }}</span
      ><button mat-menu-item (click)="auth.logout()">Sign out</button></mat-menu
    >
  `,
  styles: `
    .name {
      display: block;
      padding: 16px;
    }
  `,
})
export class HeaderComponent {
  readonly profile = inject(UserProfileService).profile;
  readonly auth = inject(AuthService);
}
