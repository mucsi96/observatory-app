import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { ErrorResponse, User } from 'oidc-client-ts';
import { USER_MANAGER } from './auth.config';
import { flushFaro } from './utils/faro';

const TERMINAL_ERRORS = new Set([
  'invalid_grant',
  'login_required',
  'interaction_required',
  'consent_required',
  'account_selection_required',
]);

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly manager = inject(USER_MANAGER);
  private readonly destroyRef = inject(DestroyRef);
  private readonly user = signal<User | null>(null);
  private readonly error = signal<string | null>(null);
  private renewal: Promise<User | null> | null = null;
  private redirecting = false;
  private lastForegroundRefresh = 0;
  readonly authError = this.error.asReadonly();
  readonly isAuthenticated = computed(
    () => !!this.user() && !this.user()!.expired
  );
  readonly userData = computed(() => this.user()?.profile ?? null);

  getAccessToken(): string | null {
    return this.user()?.access_token ?? null;
  }

  async init(): Promise<void> {
    const loaded = (user: User) => this.user.set(user);
    const unloaded = () => this.user.set(null);
    this.manager.events.addUserLoaded(loaded);
    this.manager.events.addUserUnloaded(unloaded);
    const url = new URL(window.location.href);
    const callback =
      url.searchParams.has('code') || url.searchParams.has('error');
    if (callback) {
      try {
        this.user.set(await this.manager.signinRedirectCallback());
      } catch (error) {
        this.error.set(
          url.searchParams.get('error_description') ??
            (error instanceof Error ? error.message : String(error))
        );
      } finally {
        history.replaceState(history.state, '', url.origin + url.pathname);
      }
    } else this.user.set(await this.manager.getUser());

    const foreground = () => {
      if (
        document.hidden ||
        this.error() ||
        !this.user()?.refresh_token ||
        Date.now() - this.lastForegroundRefresh < 30_000
      )
        return;
      this.lastForegroundRefresh = Date.now();
      void this.refresh('foreground').catch((error) =>
        this.reauthenticateAfterRefreshFailure(error)
      );
    };
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', foreground);
    window.addEventListener('online', foreground);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('online', foreground);
      this.manager.events.removeUserLoaded(loaded);
      this.manager.events.removeUserUnloaded(unloaded);
    });
    if (!callback && this.user()?.refresh_token) {
      this.lastForegroundRefresh = Date.now();
      await this.refresh('cold-start').catch((error) =>
        this.reauthenticateAfterRefreshFailure(error)
      );
    }
  }

  login(): void {
    if (this.redirecting) return;
    this.redirecting = true;
    this.error.set(null);
    void flushFaro()
      .then(() => this.manager.signinRedirect())
      .catch((error) => {
        this.redirecting = false;
        this.error.set(error instanceof Error ? error.message : String(error));
      });
  }

  logout(): void {
    void flushFaro()
      .then(() => this.manager.signoutRedirect())
      .catch(async () => {
        await this.manager.removeUser();
        window.location.assign(window.location.origin);
      });
  }

  async ensureAuthenticated(): Promise<boolean> {
    if (this.error() || this.redirecting) return false;
    if (this.renewal) await this.renewal.catch(() => null);
    this.user.set(await this.manager.getUser());
    if (this.isAuthenticated()) return true;
    if (this.user()?.refresh_token) {
      try {
        const user = await this.refresh('guard');
        if (user && !user.expired) return true;
      } catch (error) {
        if (this.reauthenticateAfterRefreshFailure(error)) return false;
      }
    }
    this.login();
    return false;
  }

  refresh(reason: string): Promise<User | null> {
    if (!this.renewal) {
      console.info('[auth] refreshing session', reason);
      this.renewal = this.manager
        .signinSilent()
        .then((user) => {
          this.user.set(user);
          return user;
        })
        .finally(() => {
          this.renewal = null;
        });
    }
    return this.renewal;
  }

  reauthenticateAfterRefreshFailure(error: unknown): boolean {
    if (
      !(error instanceof ErrorResponse) ||
      !error.error ||
      !TERMINAL_ERRORS.has(error.error)
    )
      return false;
    this.login();
    return true;
  }
}
