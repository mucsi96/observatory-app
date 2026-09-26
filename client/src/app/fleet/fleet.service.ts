import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  resource,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';
import { Snapshot } from './fleet.model';

@Injectable({ providedIn: 'root' })
export class FleetService {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly lastSnapshot = signal<Snapshot | undefined>(undefined);
  readonly now = signal(Date.now());
  readonly data = resource({
    loader: ({ abortSignal }) =>
      firstValueFrom(
        this.http
          .get<Snapshot>('/api/apps')
          .pipe(takeUntil(fromEvent(abortSignal, 'abort')))
      ),
  });
  readonly snapshot = computed(() =>
    this.data.hasValue() ? this.data.value() : this.lastSnapshot()
  );
  readonly stale = computed(() => {
    const snapshot = this.snapshot();
    return !!snapshot && this.now() - Date.parse(snapshot.updatedAt) > 180_000;
  });

  constructor() {
    effect(() => {
      if (this.data.hasValue()) this.lastSnapshot.set(this.data.value());
    });
    const refresh = () => {
      this.now.set(Date.now());
      if (!document.hidden) this.reload();
    };
    const timer = setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    });
  }
  reload(): void {
    if (!this.data.isLoading()) this.data.reload();
  }
}
