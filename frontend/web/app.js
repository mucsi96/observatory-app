'use strict';

const $ = (id) => document.getElementById(id);
let snapshot = null;
let busy = false;
const expanded = new Set();
const applicationKey = (app) => app.namespace || app.repository;
const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const safeURL = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
};
const link = (url, text, cls = '') =>
  safeURL(url)
    ? `<a class="${cls}" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(text)}</a>`
    : `<span>${escapeHTML(text)}</span>`;
const failures = new Set([
  'unhealthy',
  'failed',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);
const tone = (status) =>
  ['healthy', 'passed', 'success'].includes(status)
    ? 'good'
    : failures.has(status)
      ? 'bad'
      : [
            'running',
            'queued',
            'in_progress',
            'deploying',
            'degraded',
            'pending',
            'waiting',
            'requested',
          ].includes(status)
        ? 'pending'
        : 'neutral';
const badge = (status, label = status.replaceAll('_', ' ')) =>
  `<span class="badge ${tone(status)}">${escapeHTML(label)}</span>`;
const age = (date) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date)) / 60000));
  return !Number.isFinite(minutes)
    ? 'unknown time'
    : minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes}m ago`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)}h ago`
          : `${Math.floor(minutes / 1440)}d ago`;
};
const tag = (image) =>
  image.includes('@')
    ? image.split('@')[1].slice(0, 19)
    : image.slice(image.lastIndexOf('/') + 1).includes(':')
      ? image.slice(image.lastIndexOf(':') + 1)
      : 'latest (implicit)';
const applicationImages = (images) =>
  [...new Set(images)].filter(
    (image) => image.slice(image.lastIndexOf('/') + 1).split(/[:@]/)[0] !== 'oauth2-proxy',
  );

function dependencyStatus(update) {
  if (!update) return '<span class="sub">Unavailable</span>';
  const run = update.run;
  const labels = {
    'PR updated': 'PRs updated by this run:',
    'PRs created and updated': 'PRs created and updated by this run:',
  };
  const evidence = !run
    ? ''
    : update.error || update.outcome === 'unknown'
      ? '<span class="sub">PR activity unverified</span>'
      : update.outcome === 'pending'
        ? '<span class="sub">Awaiting run result</span>'
        : update.outcome === 'no PR created'
          ? '<span class="badge pending">No PR created or updated by this run</span>'
          : `<span class="sub">${labels[update.outcome] || 'PRs created by this run:'}</span>`;
  return `${run ? `Workflow: ${badge(run.status)} ${link(run.url, 'Run ↗')}<span class="sub">${escapeHTML(age(run.updatedAt))}</span>` : `<span class="sub">${update.error ? 'Unknown' : 'No dependency update runs'}</span>`}${evidence}${update.error ? '<span class="sub">Some dependency signals unavailable</span>' : ''}${(update.mrs || []).map((mr) => `<span class="sub">${link(mr.url, `#${mr.number} ${mr.title}`)} (${escapeHTML(mr.state)})</span>`).join('')}`;
}

const dependencyNeedsAttention = (update) =>
  !!update?.run &&
  (failures.has(update.run.status) ||
    ['no PR created', 'unknown'].includes(update.outcome) ||
    !!update.error);
const needsAttention = (app) =>
  !['healthy', 'not applicable'].includes(app.health) ||
  app.errors.length ||
  app.repositoryData?.mrs.some((mr) => mr.pipeline === 'failed') ||
  failures.has(app.repositoryData?.deployment?.status) ||
  dependencyNeedsAttention(app.repositoryData?.dependencyUpdate);

function details(app) {
  const repo = app.repositoryData;
  return `<tr class="details" id="details-${escapeHTML(applicationKey(app))}"><td colspan="8"><div class="detail-links">${link(app.url, app.namespace ? 'Open application ↗' : 'Open repository ↗')}${app.repository ? link(`https://github.com/${app.repository}`, 'Repository ↗') : ''}</div><div class="detail-grid"><section aria-label="${escapeHTML(app.name)} workloads"><h3>Production workloads</h3>${
    app.workloads
      .map(
        (w) =>
          `<div class="detail-item"><div>${escapeHTML(w.name)} <span class="sub">${w.ready} / ${w.desired} replicas available</span>${applicationImages(
            w.images,
          )
            .map((i) => `<code class="version">${escapeHTML(i)}</code>`)
            .join('')}</div>${badge(w.status)}</div>`,
      )
      .join('') ||
    `<p class="sub">${app.namespace ? 'No deployment data available.' : 'Repository only · Not applicable'}</p>`
  }</section><section aria-label="${escapeHTML(app.name)} pull requests"><h3>Merge requests / pull requests</h3>${repo ? repo.mrs.map((mr) => `<div class="detail-item"><div>${link(mr.url, `#${mr.number} ${mr.title}`)}${mr.draft ? '<span class="sub">Draft</span>' : ''}</div>${badge(mr.pipeline)}</div>`).join('') || '<p class="sub">All clear. No open merge requests.</p>' : '<p class="sub">Repository data unavailable.</p>'}</section></div>${app.errors.map((e) => `<p class="error">${escapeHTML(e)}</p>`).join('')}</td></tr>`;
}

function prStatus(pr) {
  const [label, glyph] = {
    passed: ['Checks passed', '✓'],
    failed: ['Checks failed', '×'],
    running: ['Checks running', '◌'],
    'no checks': ['No checks', '−'],
    unknown: ['Checks unknown', '?'],
  }[pr.pipeline];
  const description = `#${pr.number} ${pr.title}${pr.draft ? ' (draft)' : ''}: ${label}`;
  const icon = `<span role="img" aria-label="${escapeHTML(description)}" title="${escapeHTML(description)}" class="pr-icon ${tone(pr.pipeline)}">${glyph}</span>`;
  return safeURL(pr.url)
    ? `<a href="${escapeHTML(pr.url)}" target="_blank" rel="noopener noreferrer">${icon}</a>`
    : icon;
}

function render() {
  if (!snapshot) return;
  const apps = snapshot.apps;
  $('environment').textContent = snapshot.environment;
  $('total').textContent = apps.length;
  const deployed = apps.filter((app) => app.namespace);
  const healthy = deployed.filter((a) => a.health === 'healthy').length;
  $('healthy').textContent = healthy;
  $('health-caption').textContent =
    deployed.length === 0
      ? 'no Kubernetes workloads tracked'
      : healthy === deployed.length
        ? 'every application looking good'
        : `${deployed.length - healthy} need a closer look`;
  const available = apps.filter((a) => a.repositoryData);
  const partial = apps.some((a) => a.repository && !a.repositoryData);
  for (const [id, key] of [
    ['mrs', 'openMRs'],
    ['issues', 'issues'],
  ])
    $(id).textContent = available.length
      ? `${available.reduce((n, a) => n + a.repositoryData[key], 0)}${partial ? '+' : ''}`
      : '—';
  $('updated').textContent = `Updated ${age(snapshot.updatedAt)}`;
  const stale = Date.now() - new Date(snapshot.updatedAt) > 180000;
  $('notice').hidden = !stale && !apps.some((a) => a.errors.length);
  $('notice').textContent = stale
    ? 'Signals are stale. The last snapshot is shown below; check the dashboard collector.'
    : 'Some signals are unavailable. Expand an application for details. + indicates a partial total.';
  const query = $('search').value.toLowerCase().trim();
  const filtered = apps
    .filter((a) =>
      `${a.name} ${a.namespace} ${a.repository} ${a.stack?.frontend || ''} ${a.stack?.backend || ''}`
        .toLowerCase()
        .includes(query),
    )
    .filter(
      (a) =>
        $('filter').value === 'all' ||
        ($('filter').value === 'healthy' ? a.health === 'healthy' : needsAttention(a)),
    );
  $('visible-count').textContent = filtered.length;
  $('apps').innerHTML =
    filtered
      .map((app) => {
        const repo = app.repositoryData;
        const images = applicationImages(app.workloads.flatMap((w) => w.images));
        const deployment = repo?.deployment;
        const active = repo?.activeDeployment;
        const key = applicationKey(app);
        const open = expanded.has(key);
        return `<tr class="app-row${active || app.workloads.some((w) => w.status === 'deploying') ? ' deploying' : ''}"><td><div class="app-name"><span class="app-icon" aria-hidden="true">${escapeHTML(
          app.name
            .split(/\s+/)
            .map((w) => w[0])
            .join('')
            .slice(0, 2),
        )}</span><div><button class="app-toggle" data-app="${escapeHTML(key)}" aria-expanded="${open}" ${open ? `aria-controls="details-${escapeHTML(key)}"` : ''}>${escapeHTML(app.name)} <span aria-hidden="true">${open ? '−' : '+'}</span></button></div></div></td><td>${escapeHTML(app.stack?.frontend ?? 'Unknown')} / ${escapeHTML(app.stack?.backend ?? 'Unknown')}</td><td>${badge(app.health)}</td><td>${images.length ? images.map((i) => `<code class="version" title="${escapeHTML(i)}">${escapeHTML(tag(i))}</code>`).join('') : `<span class="sub">${app.namespace ? 'Not available' : 'Not applicable'}</span>`}</td><td>${active ? `${link(active.url, `Deployment pipeline ${active.status === 'in_progress' ? 'running' : active.status.replaceAll('_', ' ')}`, `badge ${tone(active.status)}`)}<span class="sub">Builds, tests and rollout · ${escapeHTML(age(active.updatedAt))}</span>` : ''}${deployment ? `${link(deployment.url, deployment.status.replaceAll('_', ' '))}<span class="sub">${escapeHTML(age(deployment.updatedAt))}</span>` : `<span class="sub">${app.namespace ? 'No recent deploy data' : 'Not applicable'}</span>`}</td><td>${dependencyStatus(repo?.dependencyUpdate)}</td><td>${repo ? (repo.mrs.length ? `<div class="pr-statuses">${repo.mrs.map(prStatus).join('')}</div>` : '<span class="sub">No open PRs</span>') : '<span class="sub">PR data unavailable</span>'}</td><td>${repo ? link(`https://github.com/${app.repository}/issues`, repo.issues, 'count count-link') : '—'}${app.repository ? `<button class="add-issue" data-issue="${escapeHTML(key)}">Add issue</button>` : ''}</td></tr>${open ? details(app) : ''}`;
      })
      .join('') ||
    '<tr><td colspan="8" class="empty">No applications match this view. Try another search or filter.</td></tr>';
}

async function refresh(manual = false) {
  if (busy) return;
  busy = true;
  if (manual) {
    $('refresh').textContent = 'Refreshing…';
    $('refresh').setAttribute('aria-label', 'Refreshing…');
  }
  $('refresh').disabled = true;
  const focused = document.activeElement?.dataset?.app;
  try {
    const response = await fetch(manual ? '/api/apps/refresh' : '/api/apps', {
      method: manual ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(manual ? { 'X-Observatory-Request': 'refresh' } : {}),
      },
      signal: AbortSignal.timeout(manual ? 65000 : 15000),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
      throw new Error(
        response.status === 503 && !snapshot
          ? 'Initial collection is still in progress. Retrying shortly…'
          : 'Could not update signals. Check your connection or sign in again by reloading this page.',
      );
    let next;
    try {
      next = globalThis.validateSnapshot(await response.json());
    } catch {
      throw new Error('The server returned an invalid snapshot.');
    }
    snapshot = next;
    render();
    if (focused) document.querySelector(`button[data-app="${CSS.escape(focused)}"]`)?.focus();
  } catch (error) {
    $('notice').hidden = false;
    $('notice').textContent =
      `${error.message}${snapshot ? ' Showing the last received snapshot.' : ''}`;
    if (!snapshot)
      $('apps').innerHTML =
        '<tr><td colspan="8" class="empty">Waiting for live data. Use Refresh to try again.</td></tr>';
  } finally {
    busy = false;
    $('refresh').textContent = 'Refresh';
    $('refresh').setAttribute('aria-label', 'Refresh');
    $('refresh').disabled = false;
  }
}

function openIssue(app, trigger) {
  const dialog = document.createElement('dialog');
  dialog.className = 'issue-dialog';
  dialog.setAttribute('aria-label', `Add issue for ${app.name}`);
  dialog.innerHTML = `<form><h2>Add issue for ${escapeHTML(app.name)}</h2><label>Title<input name="title" required maxlength="256" autofocus></label><label>Description<textarea name="description" rows="6"></textarea></label><div class="issue-feedback"></div><div class="issue-actions"><button type="button" data-cancel>Cancel</button><button type="submit" disabled>Add</button></div></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const title = form.elements.title;
  const description = form.elements.description;
  const submit = form.querySelector('[type="submit"]');
  const cancel = form.querySelector('[data-cancel]');
  const feedback = form.querySelector('.issue-feedback');
  let pending = false;
  const close = () => {
    if (!pending) {
      dialog.close();
      dialog.remove();
      (trigger.isConnected
        ? trigger
        : document.querySelector(`[data-issue="${CSS.escape(applicationKey(app))}"]`)
      )?.focus();
    }
  };
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  title.addEventListener('input', () => {
    submit.disabled = pending || !title.value.trim();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || !title.value.trim()) return;
    pending = true;
    for (const control of [title, description, submit, cancel]) control.disabled = true;
    submit.textContent = 'Adding…';
    feedback.replaceChildren();
    let success = false;
    const unconfirmed =
      'Could not confirm issue creation. Check the repository before trying again to avoid a duplicate.';
    try {
      const response = await fetch('/api/issues', {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Observatory-Request': 'create-issue' },
        body: JSON.stringify({
          repository: app.repository,
          title: title.value.trim(),
          description: description.value,
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (response.status === 401)
        throw new Error('Your session expired. Reload the dashboard to sign in again.');
      if (response.status === 403)
        throw new Error(
          'Issue creation requires the createIssues role. Ask an administrator for access.',
        );
      let result;
      try {
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
        result = await response.json();
      } catch {
        throw new Error(unconfirmed);
      }
      if (!response.ok)
        throw new Error(typeof result.error === 'string' ? result.error : unconfirmed);
      if (
        response.status !== 201 ||
        !Number.isSafeInteger(result.number) ||
        result.number < 1 ||
        result.url !== `https://github.com/${app.repository}/issues/${result.number}`
      )
        throw new Error(unconfirmed);
      feedback.innerHTML = `<p role="status">Issue #${result.number} created. ${link(result.url, `View issue #${result.number} ↗`)}</p>`;
      success = true;
      submit.hidden = true;
      cancel.textContent = 'Done';
      void refresh();
    } catch (error) {
      const alert = document.createElement('p');
      alert.setAttribute('role', 'alert');
      alert.textContent =
        error.name === 'TypeError' || error.name === 'TimeoutError' ? unconfirmed : error.message;
      feedback.append(alert);
    } finally {
      pending = false;
      cancel.disabled = false;
      if (!success) {
        title.disabled = false;
        description.disabled = false;
        submit.disabled = !title.value.trim();
        submit.textContent = 'Add';
      }
    }
  });
  dialog.showModal();
  title.focus();
}

$('apps').addEventListener('click', (event) => {
  const issue = event.target.closest('button[data-issue]');
  if (issue) {
    const app = snapshot.apps.find((app) => applicationKey(app) === issue.dataset.issue);
    if (app) openIssue(app, issue);
    return;
  }
  const button = event.target.closest('button[data-app]');
  if (!button) return;
  const id = button.dataset.app;
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  render();
  document.querySelector(`button[data-app="${CSS.escape(id)}"]`)?.focus();
});
$('search').addEventListener('input', render);
$('filter').addEventListener('change', render);
$('refresh').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 15000);
