import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { fleetSnapshot } from '../../test/fixtures';
import { server } from '../../test/server';
import { FleetDashboard } from './FleetDashboard';

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <FleetDashboard />
    </QueryClientProvider>,
  );
}

describe('fleet dashboard', () => {
  it('shows partial totals, production images, expandable workloads and draft PRs', async () => {
    renderDashboard();
    const toggle = await screen.findByRole('button', { name: 'Hello' });
    expect(screen.getByText('sha-123')).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: 'Open issues' })).getByText('3+'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: 'Open MRs / PRs' })).getByText('1+'),
    ).toBeInTheDocument();
    expect(screen.getByText('No PR created by this run')).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('ghcr.io/owner/hello:sha-123')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#12 Improve greeting' })).toHaveAttribute(
      'href',
      'https://github.com/owner/hello/pull/12',
    );
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
  });

  it('searches and filters apps while preserving expansion state', async () => {
    renderDashboard();
    await screen.findByRole('button', { name: 'Hello' });
    await userEvent.click(screen.getByRole('button', { name: 'Hello' }));
    await userEvent.type(screen.getByRole('searchbox'), 'language');
    expect(screen.queryByRole('button', { name: 'Hello' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('searchbox'));
    expect(screen.getByRole('button', { name: 'Hello' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'healthy');
    expect(screen.queryByRole('button', { name: 'Language' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox'), 'attention');
    expect(screen.getByRole('button', { name: 'Hello' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), 'nothing');
    expect(
      screen.getByText('No applications match this view. Try another search or filter.'),
    ).toBeInTheDocument();
  });

  it('distinguishes unverified dependency evidence and escapes upstream titles and URLs', async () => {
    const snapshot = fleetSnapshot();
    snapshot.apps[0].repositoryData!.dependencyUpdate = {
      run: { status: 'success', url: 'javascript:alert(1)', updatedAt: new Date().toISOString() },
      outcome: 'unknown',
      error: 'Dependency updates: upstream HTTP 410',
      mrs: [
        {
          number: 42,
          title: '<script>alert("x")</script>',
          url: 'javascript:alert(1)',
          state: 'merged',
        },
      ],
    };
    server.use(http.get('/api/apps', () => HttpResponse.json(snapshot)));
    const { container } = renderDashboard();
    await screen.findByText('PR creation unverified');
    expect(screen.getByText('Some dependency signals unavailable')).toBeInTheDocument();
    expect(screen.getByText('#42 <script>alert("x")</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.queryByText('No PR created by this run')).not.toBeInTheDocument();
  });

  it('recovers from initial collection and retains the last snapshot after a failed refresh', async () => {
    server.use(
      http.get('/api/apps', () =>
        HttpResponse.json({ error: 'Initial collection in progress' }, { status: 503 }),
      ),
    );
    renderDashboard();
    await screen.findByText('Initial collection is still in progress. Retrying shortly…');
    server.use(http.get('/api/apps', () => HttpResponse.json(fleetSnapshot())));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Hello' });
    server.use(
      http.get(
        '/api/apps',
        () =>
          new HttpResponse('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText(/Showing the last received snapshot/);
    expect(screen.getByRole('button', { name: 'Hello' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('marks old snapshots stale and rejects invalid API data', async () => {
    const snapshot = fleetSnapshot();
    snapshot.updatedAt = new Date(Date.now() - 240_000).toISOString();
    server.use(http.get('/api/apps', () => HttpResponse.json(snapshot)));
    renderDashboard();
    await screen.findByText(/Signals are stale/);
    server.use(http.get('/api/apps', () => HttpResponse.json({ apps: [] })));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText(/invalid snapshot/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Hello' })).toBeInTheDocument();
  });
});
