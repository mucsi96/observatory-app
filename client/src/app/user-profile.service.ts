import { computed, inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';
@Injectable({ providedIn: 'root' })
export class UserProfileService {
  private readonly auth = inject(AuthService);
  readonly profile = computed(() => {
    const user = this.auth.userData();
    if (!user) return null;
    const name = user.name ?? user.preferred_username ?? 'User';
    return {
      name,
      initials: name
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2),
    };
  });
}
