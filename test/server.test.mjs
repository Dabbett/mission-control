import test from "node:test";
import assert from "node:assert/strict";
import { createApp, FORCE_MIN_SECONDS } from "../src/server.mjs";
import { fetchBoard as realFetchBoard } from "../src/github.mjs";
import { exampleProjects, fixtureBoard, http } from "./helpers.mjs";

function clock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Starts an app on a random port and closes it when the test ends, pass or fail. */
async function app(t, opts = {}) {
  const calls = [];
  const c = clock();
  const projects = opts.projects ?? exampleProjects();
  const boards = opts.boards ?? [fixtureBoard()];
  const fetchBoard =
    opts.fetchBoard ??
    (async (p) => {
      calls.push(p.key);
      const next = boards.length > 1 ? boards.shift() : boards[0];
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next();
      return next;
    });
  const logs = [];
  const a = createApp({ projects, fetchBoard, now: c.now, log: (l) => logs.push(l), starter: opts.starter ?? null });
  const port = await a.listen(0);
  t.after(() => a.close());
  return { ...a, port, calls, clock: c, logs };
}

test("listens on 127.0.0.1 only", async (t) => {
  const a = await app(t);
  assert.equal(a.server.address().address, "127.0.0.1");
});

test("Host allowlist: 127.0.0.1:<port> and localhost:<port> pass, anything else is 400", async (t) => {
  const a = await app(t);
  assert.equal((await http(a.port, "/api/projects")).status, 200, "127.0.0.1");
  assert.equal((await http(a.port, "/api/projects", { host: `localhost:${a.port}` })).status, 200, "localhost");
  assert.equal((await http(a.port, "/api/projects", { host: `LOCALHOST:${a.port}` })).status, 200, "LOCALHOST");
  assert.equal((await http(a.port, "/api/projects", { host: `evil.test:${a.port}` })).status, 400, "evil.test");
  assert.equal((await http(a.port, "/api/projects", { host: "127.0.0.1:1" })).status, 400, "wrong port");
  assert.equal((await http(a.port, "/api/projects", { host: "127.0.0.1" })).status, 400, "no port");
});

test("security headers on every response, and never a CORS header", async (t) => {
  const a = await app(t);
  for (const path of ["/", "/app.js", "/api/projects", "/nope"]) {
    const r = await http(a.port, path);
    assert.match(r.headers["content-security-policy"], /default-src 'self'/);
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.ok(!Object.keys(r.headers).some((h) => h.startsWith("access-control-")), `${path} sent a CORS header`);
  }
});

test("static allowlist: three files, nothing else, no traversal", async (t) => {
  const a = await app(t);
  const index = await http(a.port, "/");
  assert.equal(index.status, 200);
  assert.match(index.headers["content-type"], /text\/html/);
  assert.ok(index.text.includes(`<meta name="mc-nonce" content="${a.nonce}">`));
  assert.ok(!index.text.includes("{{NONCE}}"));
  assert.match((await http(a.port, "/app.js")).headers["content-type"], /text\/javascript/);
  assert.match((await http(a.port, "/app.css")).headers["content-type"], /text\/css/);
  for (const p of ["/index.html", "/../package.json", "/%2e%2e/package.json", "/public/index.html", "/app.js/", "/App.js", "/projects/example.json", "/.git/config"]) {
    assert.equal((await http(a.port, p)).status, 404, p);
  }
});

test("/api/board: unknown project is 404 and fetches nothing", async (t) => {
  const a = await app(t);
  assert.equal((await http(a.port, "/api/board?project=../etc")).status, 404);
  assert.equal((await http(a.port, "/api/board?project=nope")).status, 404);
  assert.equal(a.calls.length, 0);
});

test("/api/board: serves the skeleton, then the cache until refreshSeconds", async (t) => {
  const a = await app(t);
  const r = await http(a.port, "/api/board?project=example");
  assert.equal(r.status, 200);
  assert.equal(r.json.project.key, "example");
  assert.ok(r.json.layers.length >= 4);
  assert.equal(r.json.totals.total > 0, true);
  assert.equal(r.json.start.enabled, false);
  assert.equal(a.calls.length, 1);
  a.clock.advance(30_000);
  await http(a.port, "/api/board?project=example");
  assert.equal(a.calls.length, 1);
  a.clock.advance(31_000);
  await http(a.port, "/api/board?project=example");
  assert.equal(a.calls.length, 2);
});

test("/api/board: a forced refresh is honoured only after the floor", async (t) => {
  const a = await app(t);
  await http(a.port, "/api/board?project=example");
  const soon = await http(a.port, "/api/board?project=example&force=1");
  assert.equal(soon.json.refused, "too-soon");
  assert.equal(a.calls.length, 1);
  a.clock.advance((FORCE_MIN_SECONDS + 1) * 1000);
  const later = await http(a.port, "/api/board?project=example&force=1");
  assert.equal(later.json.refused, null);
  assert.equal(a.calls.length, 2);
});

test("/api/board: concurrent requests share one fetch", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const a = await app(t, { boards: [async () => (await gate, fixtureBoard())] });
  const p1 = http(a.port, "/api/board?project=example");
  const p2 = http(a.port, "/api/board?project=example");
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(a.calls.length, 1);
});

test("/api/board: low remaining points doubles the interval and refuses forced refreshes", async (t) => {
  const low = { ...fixtureBoard(), rateLimit: { cost: 46, remaining: 100, resetAt: new Date(1_000_000_000_000 + 3600_000).toISOString() } };
  const a = await app(t, { boards: [low] });
  const r = await http(a.port, "/api/board?project=example");
  assert.equal(r.json.backoff.active, true);
  assert.equal(r.json.refreshSeconds, 120);
  a.clock.advance(61_000);
  const f = await http(a.port, "/api/board?project=example&force=1");
  assert.equal(f.json.refused, "backoff");
  assert.equal(a.calls.length, 1);
  a.clock.advance(60_000);
  await http(a.port, "/api/board?project=example");
  assert.equal(a.calls.length, 2);
});

test("/api/board: a failed refresh keeps the last good data and flags it stale", async (t) => {
  const a = await app(t, { boards: [fixtureBoard(), new Error("GitHub returned HTTP 502")] });
  const ok = await http(a.port, "/api/board?project=example");
  assert.equal(ok.json.stale, false);
  a.clock.advance(61_000);
  const stale = await http(a.port, "/api/board?project=example");
  assert.equal(stale.status, 200);
  assert.equal(stale.json.stale, true);
  assert.equal(stale.json.error, "GitHub returned HTTP 502");
  assert.ok(stale.json.layers.length > 0);
});

test("/api/board: no data at all is a 502 with the reason", async (t) => {
  const a = await app(t, { boards: [new Error("gh is not logged in")] });
  const r = await http(a.port, "/api/board?project=example");
  assert.equal(r.status, 502);
  assert.match(r.json.error, /not logged in/);
});

test("the token never reaches a response or a log line", async (t) => {
  const TOKEN = "FAKE_TOKEN_9f3a2c";
  const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const a = await app(t, { fetchBoard: (p) => realFetchBoard(p, { fetch: failing, getToken: async () => TOKEN }) });
  const r = await http(a.port, "/api/board?project=example");
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes(TOKEN));
  assert.ok(!a.logs.join("\n").includes(TOKEN));
});

test("API routes refuse browser cross-site requests, so no other page can force refetches", async (t) => {
  const a = await app(t);
  for (const path of ["/api/board?project=example&force=1", "/api/projects"]) {
    assert.equal((await http(a.port, path, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, `${path} cross-site`);
    assert.equal((await http(a.port, path, { headers: { "sec-fetch-site": "same-site" } })).status, 403, `${path} same-site`);
    assert.equal((await http(a.port, path, { headers: { "sec-fetch-site": "same-origin" } })).status, 200, `${path} same-origin`);
    assert.equal((await http(a.port, path, { headers: { "sec-fetch-site": "none" } })).status, 200, `${path} none`);
    assert.equal((await http(a.port, path)).status, 200, `${path} absent`);
  }
  assert.equal(a.calls.length, 1, "the cross-site forced refresh fetched nothing");
});

test("/api/board: a failing GitHub is not hammered before the interval", async (t) => {
  const a = await app(t, { boards: [new Error("down"), new Error("down"), fixtureBoard()] });
  assert.equal((await http(a.port, "/api/board?project=example")).status, 502);
  assert.equal((await http(a.port, "/api/board?project=example")).status, 502);
  assert.equal(a.calls.length, 1);
  a.clock.advance(61_000);
  assert.equal((await http(a.port, "/api/board?project=example")).status, 502);
  assert.equal(a.calls.length, 2);
  a.clock.advance(61_000);
  assert.equal((await http(a.port, "/api/board?project=example")).status, 200);
  assert.equal(a.calls.length, 3);
});

test("/api/board: partial read errors from GitHub are passed to the page", async (t) => {
  const a = await app(t, { boards: [{ ...fixtureBoard(), partial: ["FORBIDDEN at 3.content.blockedBy.nodes.0: Resource not accessible"] }] });
  const r = await http(a.port, "/api/board?project=example");
  assert.deepEqual(r.json.partial, ["FORBIDDEN at 3.content.blockedBy.nodes.0: Resource not accessible"]);
});

test("/api/start is 404 when no starter is configured", async (t) => {
  const a = await app(t);
  const r = await http(a.port, "/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
});

test("Ready leaves carry their model; a bad model label drops the command and says why, without failing the board", async (t) => {
  const b = fixtureBoard();
  const node = b.nodes.find((n) => n.content?.number === 6);
  node.content.labels = { totalCount: 1, nodes: [{ name: "model:gpt-5" }] };
  const a = await app(t, { boards: [b] });
  const r = await http(a.port, "/api/board?project=example");
  assert.equal(r.status, 200);
  const leaves = r.json.layers.flatMap((l) => l.groups.flatMap((g) => g.parts.flatMap((p) => p.leaves)));
  const bad = leaves.find((l) => l.number === 6);
  assert.equal(bad.state, "ready");
  assert.equal(bad.copy, undefined);
  assert.match(bad.commandError, /not in model\.allowed/);
  const good = leaves.find((l) => l.state === "ready" && l.number !== 6);
  assert.equal(good.model, "opus");
  assert.equal(good.modelSource, "default");
  assert.ok(good.copy.includes("'--model' 'opus'"));
});
