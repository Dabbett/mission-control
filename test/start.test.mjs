import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { createStarter, childEnv, CHILD_ENV_KEYS } from "../src/start.mjs";
import { createApp } from "../src/server.mjs";
import { normalize } from "../src/model.mjs";
import { root, exampleProjects, fixtureBoard, http } from "./helpers.mjs";

// The example's localPath does not exist on any machine, and Start refuses a missing checkout, so point it at this repo.
const projects = exampleProjects({ start: { enabled: true }, localPath: root });
const example = projects.get("example");
const normalized = normalize(fixtureBoard(), example);

function starter(opts = {}) {
  const launches = [];
  const s = createStarter({ root, launch: opts.launch ?? (async (argv) => void launches.push(argv)), now: () => 1_700_000_000_000, node: "/usr/local/bin/node" });
  return { s, launches };
}

test("start: a Ready issue launches Ghostty with an argv-only command and absolute paths", async () => {
  const { s, launches } = starter();
  const r = await s.start(example, 6, { normalized });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(launches.length, 1);
  const argv = launches[0];
  assert.deepEqual(argv.slice(0, 5), ["-na", "Ghostty.app", "--args", "--quit-after-last-window-closed=true", "-e"]);
  assert.equal(argv[5], "/usr/local/bin/node");
  assert.equal(argv[6], join(root, "bin", "launch.mjs"));
  assert.ok(isAbsolute(argv[6]));
  assert.deepEqual(argv.slice(7, 10), ["--cwd", example.localPath, "--"]);
  assert.ok(isAbsolute(example.localPath));
  assert.deepEqual(argv.slice(10, 17), ["claude", "--model", "opus", "-w", "issue-6", "--name", "#6"]);
  assert.match(argv[17], /^Read AGENTS\.md, then plan and work issue #6/);
  assert.equal(argv.length, 18);
  for (const a of argv) assert.ok(!/[\r\n]/.test(a));
  assert.equal(r.body.model, "opus");
  assert.deepEqual(s.startedFor("example"), { 6: "2023-11-14T22:13:20.000Z" });
});

test("start: an assigned issue needs confirm, because someone may already have claimed it", async () => {
  const n = normalize(fixtureBoard(), example);
  n.items.set(6, { ...n.items.get(6), assignees: ["someone"] });
  const { s, launches } = starter();
  const first = await s.start(example, 6, { normalized: n });
  assert.equal(first.status, 409);
  assert.deepEqual(first.body.requiresConfirm, ["assigned"]);
  assert.deepEqual(first.body.assignees, ["someone"]);
  assert.equal(launches.length, 0);
  assert.equal((await s.start(example, 6, { normalized: n, confirm: { started: true } })).status, 409, "the other reason's confirm does not pass");
  const again = await s.start(example, 6, { normalized: n, confirm: { assigned: true } });
  assert.equal(again.status, 200);
  assert.equal(launches.length, 1);
});

test("start: a model label picks the model, and a label outside the allowlist is refused before launch", async () => {
  const withLabel = (labels) => {
    const n = normalize(fixtureBoard(), example);
    n.items.set(6, { ...n.items.get(6), labels });
    return n;
  };
  const { s, launches } = starter();
  const ok = await s.start(example, 6, { normalized: withLabel(["model:sonnet"]) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.model, "sonnet");
  assert.deepEqual(launches[0].slice(10, 13), ["claude", "--model", "sonnet"]);
  const bad = await starter().s.start(example, 6, { normalized: withLabel(["model:gpt-5"]) });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /not in model\.allowed/);
  const two = await starter().s.start(example, 6, { normalized: withLabel(["model:opus", "Model:Sonnet"]) });
  assert.equal(two.status, 409);
  assert.match(two.body.error, /keep one/);
});

test("start: a Blocked issue, a Decision and an unknown number are refused", async () => {
  const { s, launches } = starter();
  const blocked = await s.start(example, 36, { normalized });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /blocked, not Ready/);
  assert.equal(blocked.body.requiresConfirm, undefined);
  const decision = await s.start(example, 28, { normalized });
  assert.equal(decision.status, 409);
  const missing = await s.start(example, 999, { normalized });
  assert.equal(missing.status, 404);
  assert.equal(launches.length, 0);
});

test("start: a repeat needs confirm, and the marker stays until restart", async () => {
  const { s, launches } = starter();
  assert.equal((await s.start(example, 6, { normalized })).status, 200);
  const again = await s.start(example, 6, { normalized });
  assert.equal(again.status, 409);
  assert.deepEqual(again.body.requiresConfirm, ["started"]);
  assert.equal(again.body.startedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(launches.length, 1);
  assert.equal((await s.start(example, 6, { normalized, confirm: { assigned: true } })).status, 409, "the other reason's confirm does not pass");
  const confirmed = await s.start(example, 6, { normalized, confirm: { started: true } });
  assert.equal(confirmed.status, 200);
  assert.equal(launches.length, 2);
});

test("start: concurrent starts of the same issue share one launch", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { s, launches } = starter({ launch: async (argv) => (launches.push(argv), await gate) });
  const p1 = s.start(example, 6, { normalized });
  const p2 = s.start(example, 6, { normalized });
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 429]);
  assert.equal(launches.length, 1);
});

test("start: a failed launch reports and sets no marker", async () => {
  const { s } = starter({ launch: async () => { throw new Error("open: not found"); } });
  const r = await s.start(example, 6, { normalized });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /launch failed: open: not found/);
  assert.deepEqual(s.startedFor("example"), {});
});

test("start: a missing checkout is a 409 with reason localPath, before any launch", async () => {
  const missing = { ...example, localPath: join(root, "does-not-exist") };
  const { s, launches } = starter();
  const r = await s.start(missing, 6, { normalized });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, "localPath");
  assert.match(r.body.error, /localPath does not exist/);
  const file = await s.start({ ...example, localPath: join(root, "package.json") }, 6, { normalized });
  assert.equal(file.body.reason, "localPath", "a file is not a checkout");
  assert.equal(launches.length, 0);
  assert.deepEqual(s.startedFor("example"), {});
});

test("start: the session gets an allowlisted environment, never the server's token or keys", async () => {
  const env = { PATH: "/bin", HOME: "/h", TERM: "xterm", MISSION_CONTROL_TOKEN: "t", GITHUB_TOKEN: "g", ANTHROPIC_API_KEY: "k", NUM: 3 };
  assert.deepEqual(childEnv(env), { PATH: "/bin", HOME: "/h", TERM: "xterm" });
  for (const k of CHILD_ENV_KEYS) assert.ok(!/TOKEN|KEY|SECRET/.test(k));
  const seen = [];
  const { s } = starter({ launch: async (argv, opts) => void seen.push(opts) });
  assert.equal((await s.start(example, 6, { normalized })).status, 200);
  assert.deepEqual(seen, [{ env: childEnv() }]);
});

// ── through the server ───────────────────────────────────────────────────────

async function app(t, opts = {}) {
  const { s, launches } = starter(opts);
  const boards = opts.boards ?? [fixtureBoard()];
  let fetches = 0;
  const fetchBoard = async () => {
    fetches++;
    const next = boards.length > 1 ? boards.shift() : boards[0];
    if (next instanceof Error) throw next;
    return next;
  };
  const a = createApp({ projects: opts.projects ?? projects, fetchBoard, now: opts.now ?? (() => Date.now()), starter: s });
  const port = await a.listen(0);
  t.after(() => a.close());
  const host = `127.0.0.1:${port}`;
  const good = { "content-type": "application/json", origin: `http://${host}`, "sec-fetch-site": "same-origin", "x-mc-nonce": a.nonce };
  const post = (body, headers = good, extra = {}) => http(port, "/api/start", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), ...extra });
  return { a, port, post, good, launches, fetchCount: () => fetches };
}

test("server start: the full happy path refetches, launches and reports the marker on the board", async (t) => {
  const { a, port, post, launches, fetchCount } = await app(t);
  const before = await http(port, "/api/board?project=example");
  assert.equal(before.json.start.enabled, true);
  assert.deepEqual(before.json.start.started, {});
  const r = await post({ project: "example", number: 6 });
  assert.equal(r.status, 200, r.text);
  assert.equal(launches.length, 1);
  assert.equal(fetchCount(), 2, "start refetches before launching");
  const after = await http(port, "/api/board?project=example");
  assert.ok(after.json.start.started[6]);
  assert.ok(after.json.layers.some((l) => l.groups.some((g) => g.parts.some((p) => p.leaves.some((x) => x.number === 6 && typeof x.copy === "string" && x.copy.startsWith("cd '/"))))));
  void a;
});

test("server start: cross-site, wrong origin, missing nonce, wrong content type", async (t) => {
  const { a, post, good, launches } = await app(t);
  assert.equal((await post({ project: "example", number: 6 }, { ...good, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ project: "example", number: 6 }, { ...good, "sec-fetch-site": "none" })).status, 403);
  assert.equal((await post({ project: "example", number: 6 }, { ...good, origin: "http://evil.test" })).status, 403);
  const wrong = await post({ project: "example", number: 6 }, { ...good, "x-mc-nonce": "wrong" });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.runId, a.runId, "a dead nonce comes back with the live run id, so the page can offer a reload");
  const noNonce = { ...good };
  delete noNonce["x-mc-nonce"];
  assert.equal((await post({ project: "example", number: 6 }, noNonce)).status, 403);
  assert.equal((await post({ project: "example", number: 6 }, { ...good, "content-type": "text/plain" })).status, 415);
  assert.equal(launches.length, 0);
});

test("server start: body validation", async (t) => {
  const { post, launches } = await app(t);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post({ project: "example", number: "6" })).status, 400);
  assert.equal((await post({ project: "example", number: -1 })).status, 400);
  assert.equal((await post({ project: "example", number: 1.5 })).status, 400);
  assert.equal((await post({ project: "nope", number: 6 })).status, 404);
  assert.equal((await post({ project: "../x", number: 6 })).status, 404);
  const big = JSON.stringify({ project: "example", number: 6, pad: "x".repeat(5000) });
  assert.equal((await post(big)).status, 413);
  assert.equal(launches.length, 0);
});

test("server start: non-Ready is 409, a repeat needs confirm, a double click is 429", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const launches = [];
  const { post } = await app(t, { launch: async (argv) => (launches.push(argv), await gate) });
  assert.equal((await post({ project: "example", number: 36 })).status, 409);
  const p1 = post({ project: "example", number: 6 });
  await new Promise((r) => setTimeout(r, 30));
  const p2 = post({ project: "example", number: 6 });
  await new Promise((r) => setTimeout(r, 30));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 429]);
  const again = await post({ project: "example", number: 6 });
  assert.equal(again.status, 409);
  assert.deepEqual(again.json.requiresConfirm, ["started"]);
  assert.equal((await post({ project: "example", number: 6, confirm: true })).status, 409, "a bare true confirms nothing");
  assert.equal((await post({ project: "example", number: 6, confirm: { started: "yes" } })).status, 409, "only a literal true counts");
  assert.equal((await post({ project: "example", number: 6, confirm: { started: true } })).status, 200);
  assert.equal(launches.length, 2);
});

test("server start: disabled project is 404 even with a starter present", async (t) => {
  const { post, launches } = await app(t, { projects: exampleProjects({ start: { enabled: false } }) });
  assert.equal((await post({ project: "example", number: 6 })).status, 404);
  assert.equal(launches.length, 0);
});

test("server start: a failed refetch is 502 and launches nothing, even with old data cached", async (t) => {
  const { port, post, launches, fetchCount } = await app(t, { boards: [fixtureBoard(), new Error("GitHub returned HTTP 502")] });
  assert.equal((await http(port, "/api/board?project=example")).status, 200);
  const r = await post({ project: "example", number: 6 });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /not starting/);
  assert.equal(fetchCount(), 2);
  assert.equal(launches.length, 0);
});

test("server start: refuses while backed off instead of fetching", async (t) => {
  const low = { ...fixtureBoard(), rateLimit: { cost: 46, remaining: 10, resetAt: new Date(Date.now() + 3600_000).toISOString() } };
  const { port, post, launches, fetchCount } = await app(t, { boards: [low] });
  await http(port, "/api/board?project=example");
  const r = await post({ project: "example", number: 6 });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /backoff/);
  assert.equal(fetchCount(), 1);
  assert.equal(launches.length, 0);
});

test("server start: an assigned issue comes back 409 with its assignees, and starts on confirm", async (t) => {
  const b = fixtureBoard();
  b.nodes.find((n) => n.content?.number === 6).content.assignees = { totalCount: 1, nodes: [{ login: "someone" }] };
  const { post, launches } = await app(t, { boards: [b] });
  const first = await post({ project: "example", number: 6 });
  assert.equal(first.status, 409);
  assert.deepEqual(first.json.requiresConfirm, ["assigned"]);
  assert.deepEqual(first.json.assignees, ["someone"]);
  assert.equal(launches.length, 0);
  const again = await post({ project: "example", number: 6, confirm: { assigned: true } });
  assert.equal(again.status, 200);
  assert.equal(launches.length, 1);
});

test("start: started and assigned at once needs both confirms, and each one alone is refused", async () => {
  const n = normalize(fixtureBoard(), example);
  const { s, launches } = starter();
  assert.equal((await s.start(example, 6, { normalized: n })).status, 200);
  n.items.set(6, { ...n.items.get(6), assignees: ["someone"] });
  const neither = await s.start(example, 6, { normalized: n, confirm: null });
  assert.deepEqual(neither.body.requiresConfirm, ["started", "assigned"], "both reasons in one refusal; a null confirm confirms nothing");
  assert.match(neither.body.error, /was started at .* and is assigned to someone/);
  assert.deepEqual((await s.start(example, 6, { normalized: n, confirm: { started: true } })).body.requiresConfirm, ["assigned"]);
  assert.deepEqual((await s.start(example, 6, { normalized: n, confirm: { assigned: true } })).body.requiresConfirm, ["started"]);
  assert.equal(launches.length, 1);
  assert.equal((await s.start(example, 6, { normalized: n, confirm: { started: true, assigned: true } })).status, 200);
  assert.equal(launches.length, 2);
});

test("server start: the refetch behind a refused start updates the cached board, so the page's reload shows the new reason", async (t) => {
  const before = fixtureBoard();
  const after = fixtureBoard();
  after.nodes.find((n) => n.content?.number === 6).content.assignees = { totalCount: 1, nodes: [{ login: "someone" }] };
  const { port, post } = await app(t, { boards: [before, after] });
  const leaf6 = (r) => r.json.layers.flatMap((l) => l.groups.flatMap((g) => g.parts.flatMap((p) => p.leaves))).find((l) => l.number === 6);
  assert.deepEqual(leaf6(await http(port, "/api/board?project=example")).assignees, []);
  const refused = await post({ project: "example", number: 6 });
  assert.deepEqual(refused.json.requiresConfirm, ["assigned"]);
  assert.deepEqual(leaf6(await http(port, "/api/board?project=example")).assignees, ["someone"], "a plain load(false) sees the assignee");
});
