import { describe, expect, it } from 'vitest';
import { fleetSnapshot } from '../../test/fixtures';
import { dependencyNeedsAttention, filterApplications, imageVersion } from './selectors';

describe('fleet signals', () => {
  it('treats missing evidence as attention, pending as pending, and successful creation as clear', () => {
    const update = fleetSnapshot().apps[0].repositoryData!.dependencyUpdate!;
    expect(dependencyNeedsAttention(update)).toBe(true);
    update.outcome = 'unknown';
    expect(dependencyNeedsAttention(update)).toBe(true);
    update.outcome = 'pending';
    update.run!.status = 'in_progress';
    expect(dependencyNeedsAttention(update)).toBe(false);
    update.outcome = 'PR created';
    update.run!.status = 'success';
    expect(dependencyNeedsAttention(update)).toBe(false);
    update.run!.status = 'stale';
    expect(dependencyNeedsAttention(update)).toBe(true);
  });

  it('includes dependency evidence regressions even when Kubernetes and PR checks pass', () => {
    const snapshot = fleetSnapshot();
    const app = snapshot.apps[0];
    app.repositoryData!.mrs[0].pipeline = 'passed';
    expect(filterApplications([app], '', 'attention')).toHaveLength(1);
    app.repositoryData!.dependencyUpdate!.outcome = 'PR created';
    expect(filterApplications([app], '', 'attention')).toHaveLength(0);
  });

  it('handles registry ports, image digests and implicit tags', () => {
    expect(imageVersion('registry:5000/team/app:v2')).toBe('v2');
    expect(imageVersion('registry:5000/team/app')).toBe('latest (implicit)');
    expect(imageVersion('app@sha256:0123456789abcdef')).toBe('sha256:0123456789ab');
  });
});
