"use strict";

const $ = (id) => document.getElementById(id);
let snapshot = null;
let busy = false;
const expanded = new Set();
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const link = (url, text, cls = "") => {
  try { if (new URL(url).protocol !== "https:") return escapeHTML(text); } catch { return escapeHTML(text); }
  return `<a class="${cls}" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(text)}</a>`;
};
const tone = (status) => ["healthy", "passed", "success"].includes(status) ? "good" : ["unhealthy", "failed", "failure", "cancelled", "timed_out"].includes(status) ? "bad" : ["running", "queued", "in_progress", "deploying", "degraded", "pending", "waiting"].includes(status) ? "pending" : "neutral";
const badge = (status) => `<span class="badge ${tone(status)}">${escapeHTML(status.replaceAll("_", " "))}</span>`;
const age = (date) => { const minutes = Math.max(0, Math.floor((Date.now() - new Date(date)) / 60000)); return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`; };
const tag = (image) => image.includes("@") ? image.split("@")[1].slice(0, 19) : image.slice(image.lastIndexOf("/") + 1).includes(":") ? image.slice(image.lastIndexOf(":") + 1) : "latest (implicit)";

function details(app) {
  const repo = app.repositoryData;
  return `<tr class="details" id="details-${escapeHTML(app.namespace)}"><td colspan="6"><div class="detail-links">${link(app.url, "Open application ↗")}${app.repository ? link(`https://github.com/${app.repository}`, "Repository ↗") : ""}</div><div class="detail-grid"><div><h3>Production workloads</h3>${app.workloads.map(w => `<div class="detail-item"><div>${escapeHTML(w.name)} <span class="sub">${w.ready} / ${w.desired} replicas available</span>${w.images.map(i => `<span class="version">${escapeHTML(i)}</span>`).join("")}</div>${badge(w.status)}</div>`).join("") || '<p class="sub">No deployment data available.</p>'}</div><div><h3>Merge requests / pull requests</h3>${repo ? repo.mrs.map(mr => `<div class="detail-item"><div>${link(mr.url, `#${mr.number} ${mr.title}`)}${mr.draft ? '<span class="sub">Draft</span>' : ""}</div>${badge(mr.pipeline)}</div>`).join("") || '<p class="sub">All clear. No open merge requests.</p>' : '<p class="sub">Repository data unavailable.</p>'}</div></div>${app.errors.map(e => `<p class="error">${escapeHTML(e)}</p>`).join("")}</td></tr>`;
}

function render() {
  if (!snapshot) return;
  const apps = snapshot.apps;
  $("environment").textContent = snapshot.environment;
  $("total").textContent = apps.length;
  const healthy = apps.filter(a => a.health === "healthy").length;
  $("healthy").textContent = healthy;
  $("health-caption").textContent = healthy === apps.length ? "every application looking good" : `${apps.length - healthy} need a closer look`;
  const available = apps.filter(a => a.repositoryData);
  const partial = apps.some(a => a.repository && !a.repositoryData);
  for (const [id, key] of [["mrs", "openMRs"], ["issues", "issues"]]) $(id).textContent = available.length ? `${available.reduce((n, a) => n + a.repositoryData[key], 0)}${partial ? "+" : ""}` : "—";
  $("updated").textContent = `Updated ${age(snapshot.updatedAt)}`;
  const stale = Date.now() - new Date(snapshot.updatedAt) > 180000;
  $("notice").hidden = !stale && !apps.some(a => a.errors.length);
  $("notice").textContent = stale ? "Signals are stale. The last snapshot is shown below; check the dashboard collector." : "Some signals are unavailable. Expand an application for details. + indicates a partial total.";
  const query = $("search").value.toLowerCase().trim();
  const filtered = apps.filter(a => `${a.name} ${a.namespace} ${a.repository}`.toLowerCase().includes(query)).filter(a => $("filter").value === "all" || ($("filter").value === "healthy" ? a.health === "healthy" : a.health !== "healthy" || a.errors.length || a.repositoryData?.mrs.some(m => m.pipeline === "failed") || ["failure", "cancelled", "timed_out"].includes(a.repositoryData?.deployment?.status)));
  $("visible-count").textContent = filtered.length;
  $("apps").innerHTML = filtered.map(app => {
    const repo = app.repositoryData;
    const images = [...new Set(app.workloads.flatMap(w => w.images))];
    const deployment = repo?.deployment;
    const open = expanded.has(app.namespace);
    return `<tr class="app-row"><td><div class="app-name"><span class="app-icon" aria-hidden="true">${escapeHTML(app.name.split(/\s+/).map(w => w[0]).join("").slice(0,2))}</span><div><button class="app-toggle" data-app="${escapeHTML(app.namespace)}" aria-expanded="${open}" ${open ? `aria-controls="details-${escapeHTML(app.namespace)}"` : ""}>${escapeHTML(app.name)} <span aria-hidden="true">${open ? "−" : "+"}</span></button><span class="sub">${escapeHTML(new URL(app.url).hostname)}</span></div></div></td><td>${badge(app.health)}</td><td>${images.length ? images.map(i => `<div class="version" title="${escapeHTML(i)}">${escapeHTML(tag(i))}</div>`).join("") : '<span class="sub">Not available</span>'}</td><td>${deployment ? `${link(deployment.url, deployment.status.replaceAll("_", " "))}<span class="sub">${escapeHTML(age(deployment.updatedAt))}</span>` : '<span class="sub">No recent deploy data</span>'}</td><td>${repo ? `${link(`https://github.com/${app.repository}/pulls`, repo.openMRs, "count count-link")}<span class="sub">${repo.mrs.filter(m => m.pipeline === "failed").length} failing · ${repo.mrs.filter(m => m.pipeline === "running").length} running</span>` : "—"}</td><td>${repo ? link(`https://github.com/${app.repository}/issues`, repo.issues, "count count-link") : "—"}</td></tr>${open ? details(app) : ""}`;
  }).join("") || '<tr><td colspan="6" class="empty">No applications match this view. Try another search or filter.</td></tr>';
}

async function refresh() {
  if (busy) return;
  busy = true; $("refresh").disabled = true;
  try {
    const response = await fetch("/api/apps", {headers: {Accept: "application/json"}, signal: AbortSignal.timeout(15000)});
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error(response.status === 503 ? "Initial collection is still in progress. Retrying shortly…" : "Could not update signals. Check your connection or sign in again by reloading this page.");
    snapshot = await response.json(); render();
  } catch (error) {
    $("notice").hidden = false;
    $("notice").textContent = `${error.message}${snapshot ? " Showing the last received snapshot." : ""}`;
    if (!snapshot) $("apps").innerHTML = '<tr><td colspan="6" class="empty">Waiting for live data. Use Refresh to try again.</td></tr>';
  } finally { busy = false; $("refresh").disabled = false; }
}
$("apps").addEventListener("click", event => {
  const button = event.target.closest("button[data-app]"); if (!button) return;
  const id = button.dataset.app; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render();
  document.querySelector(`button[data-app="${CSS.escape(id)}"]`)?.focus();
});
$("search").addEventListener("input", render);
$("filter").addEventListener("change", render);
$("refresh").addEventListener("click", refresh);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 15000);
