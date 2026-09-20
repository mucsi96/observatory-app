import { Component, computed, input } from '@angular/core';
@Component({
  selector: 'app-status-badge',
  template: `<span [class]="tone()">{{ status().replaceAll('_', ' ') }}</span>`,
  styles: `
    span {
      display: inline-block;
      border: 1px solid currentColor;
      border-radius: 16px;
      padding: 3px 9px;
      white-space: nowrap;
      font-size: 12px;
    }
    .good {
      color: var(--bt-success);
    }
    .bad {
      color: var(--bt-error);
    }
    .pending {
      color: var(--bt-warn);
    }
    .neutral {
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class StatusBadgeComponent {
  readonly status = input.required<string>();
  readonly tone = computed(() =>
    ['healthy', 'passed', 'success'].includes(this.status())
      ? 'good'
      : ['unhealthy', 'failed', 'failure', 'cancelled', 'timed_out'].includes(
            this.status()
          )
        ? 'bad'
        : [
              'running',
              'queued',
              'in_progress',
              'deploying',
              'degraded',
              'pending',
              'waiting',
            ].includes(this.status())
          ? 'pending'
          : 'neutral'
  );
}
