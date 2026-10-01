const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

function dashboard() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: id === "filter" ? "all" : "", addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, addEventListener() {} },
    URL, AbortSignal, setInterval() {}, fetch: () => new Promise(() => {}),
  });
  vm.runInContext(readFileSync(new URL("../web/app.js", `file://${__filename}`), "utf8"), context);
  return { context, element };
}

test("dependency run states, missing data and safe PR links", () => {
  const { context } = dashboard();
  const render = (data) => vm.runInContext(`dependencyStatus(${JSON.stringify(data)})`, context);
  assert.match(render(null), /Unavailable/);
  assert.match(render({}), /No dependency update runs/);
  assert.match(render({ error: "upstream HTTP 403" }), /Unknown/);
  const update = { run: { status: "failure", url: "https://github.com/o/r/actions/runs/1", updatedAt: new Date().toISOString() } };
  assert.match(render(update), /badge bad/);
  assert.match(render(update), /No Renovate PR found/);
  assert.match(render(update), /href="https:\/\/github.com\/o\/r\/actions\/runs\/1"/);
  update.error = "PR lookup failed";
  assert.match(render(update), /Some dependency signals unavailable/);
  assert.doesNotMatch(render(update), /No Renovate PR found/);
  update.mr = { number: 42, title: '<script>alert("x")</script>', url: "javascript:alert(1)", state: "merged" };
  assert.match(render(update), /#42 &lt;script&gt;/);
  assert.match(render(update), /merged/);
  assert.doesNotMatch(render(update), /<script>|href="javascript:/);
  update.mr.url = "https://github.com/o/r/pull/42";
  assert.match(render(update), /href="https:\/\/github.com\/o\/r\/pull\/42"/);
  const withoutRun = render({ mr: update.mr });
  assert.match(withoutRun, /No dependency update runs/);
  assert.match(withoutRun, /href="https:\/\/github.com\/o\/r\/pull\/42"/);
});

test("failed dependency update appears in attention filter and seven-column rows", () => {
  const { context, element } = dashboard();
  const app = {
    name: "Example", namespace: "example", url: "https://example.com", repository: "o/r",
    health: "healthy", errors: [], workloads: [],
    repositoryData: { openMRs: 0, issues: 0, mrs: [], dependencyUpdate: {
      run: { status: "failure", url: "https://github.com/o/r/actions/runs/1", updatedAt: new Date().toISOString() },
    } },
  };
  element("filter").value = "attention";
  vm.runInContext(`snapshot = ${JSON.stringify({ environment: "test", updatedAt: new Date().toISOString(), apps: [app] })}; expanded.add("example"); render();`, context);
  assert.equal(element("visible-count").textContent, 1);
  assert.match(element("apps").innerHTML, /badge bad/);
  assert.match(element("apps").innerHTML, /colspan="7"/);
  assert.equal((element("apps").innerHTML.split('<tr class="details"')[0].match(/<td>/g) || []).length, 7);
  vm.runInContext('snapshot.apps[0].repositoryData.dependencyUpdate.run.status = "stale"; render();', context);
  assert.equal(element("visible-count").textContent, 1);
  assert.match(element("apps").innerHTML, /badge bad">stale/);
  vm.runInContext('snapshot.apps[0].repositoryData.dependencyUpdate.run.status = "success"; render();', context);
  assert.equal(element("visible-count").textContent, 0);
  assert.match(element("apps").innerHTML, /colspan="7" class="empty"/);
});
