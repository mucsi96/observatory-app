import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { BarLoaderComponent } from '@mucsi96/angular-material-theme';
import { FleetService } from './fleet.service';
import { Application } from './fleet.model';
import { StatusBadgeComponent } from './status-badge.component';

@Component({
  selector: 'app-fleet',
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTableModule,
    BarLoaderComponent,
    StatusBadgeComponent,
  ],
  templateUrl: './fleet.component.html',
  styleUrl: './fleet.component.css',
})
export class FleetComponent {
  readonly fleet = inject(FleetService);
  readonly search = signal('');
  readonly filter = signal('all');
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly columns = [
    'application',
    'health',
    'version',
    'deployment',
    'mrs',
    'issues',
  ];
  readonly applications = computed(() => this.fleet.snapshot()?.apps ?? []);
  readonly healthy = computed(
    () => this.applications().filter((app) => app.health === 'healthy').length
  );
  readonly partial = computed(() =>
    this.applications().some((app) => app.repository && !app.repositoryData)
  );
  readonly hasErrors = computed(() =>
    this.applications().some((app) => app.errors.length)
  );
  readonly filtered = computed(() =>
    this.applications()
      .filter((app) =>
        `${app.name} ${app.namespace} ${app.repository}`
          .toLowerCase()
          .includes(this.search().trim().toLowerCase())
      )
      .filter(
        (app) =>
          this.filter() === 'all' ||
          (this.filter() === 'healthy'
            ? app.health === 'healthy'
            : app.health !== 'healthy' ||
              app.errors.length > 0 ||
              app.repositoryData?.mrs.some((mr) => mr.pipeline === 'failed') ||
              ['failure', 'cancelled', 'timed_out'].includes(
                app.repositoryData?.deployment?.status ?? ''
              ))
      )
  );

  total(key: 'openMRs' | 'issues'): string {
    const available = this.applications().filter((app) => app.repositoryData);
    return available.length
      ? `${available.reduce((sum, app) => sum + app.repositoryData![key], 0)}${this.partial() ? '+' : ''}`
      : '—';
  }
  toggle(namespace: string): void {
    this.expanded.update((current) =>
      current.has(namespace)
        ? new Set([...current].filter((item) => item !== namespace))
        : new Set([...current, namespace])
    );
  }
  images(app: Application): string[] {
    return [...new Set(app.workloads.flatMap((workload) => workload.images))];
  }
  tag(image: string): string {
    return image.includes('@')
      ? image.split('@')[1].slice(0, 19)
      : image.slice(image.lastIndexOf('/') + 1).includes(':')
        ? image.slice(image.lastIndexOf(':') + 1)
        : 'latest (implicit)';
  }
  safeURL(url: string): string | null {
    try {
      return new URL(url).protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  }
}
