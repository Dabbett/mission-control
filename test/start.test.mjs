import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { createStarter, childEnv, CHILD_ENV_KEYS } from "../src/start.mjs";
import { createApp } from "../src/server.mjs";
import { normalize } from "../src/model.mjs";
import { root, exampleProjects, fixtureBoard, claimableBoard, http } from "./helpers.mjs";

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

test("start: an issue whose Status the config does not list is refused, though the board shows it Ready", async () => {
  const n = normalize(fixtureBoard(), example);
  n.items.set(6, { ...n.items.get(6), status: "Waiting" });
  const { s, launches } = starter();
  const r = await s.start(example, 6, { normalized: n });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, "status");
  assert.match(r.body.error, /Status "Waiting" is in none of the config's status lists/);
  assert.equal(launches.length, 0);
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

// ── the opt-in claim ────────────────────────────────────────────────────────

const claimProjects = exampleProjects({ start: { enabled: true, claim: "dashboard" }, localPath: root });
const claimExample = claimProjects.get("example");

/** A claimer that records every call, in order with the launches, and answers as told. */
function fakeClaimer(events, { claim, unclaim } = {}) {
  return {
    claim: async (ctx) => (events.push(["claim", ctx]), claim ? claim(ctx) : { ok: true, assigned: true, statusSet: true, assignees: ["me"] }),
    unclaim: async (ctx, undo, landed) => (events.push(["unclaim", undo, landed]), unclaim ? unclaim() : { ok: true }),
  };
}

function claimStarter(events, opts = {}) {
  const launch = opts.launch ?? (async (argv) => void events.push(["launch", argv[10]]));
  return createStarter({ root, launch, now: () => 1_700_000_000_000, node: "/usr/local/bin/node", claimer: fakeClaimer(events, opts) });
}

test("claim: with start.claim dashboard, the issue is claimed before anything launches, and the reply says so", async () => {
  const events = [];
  const r = await claimStarter(events).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(events.map((e) => e[0]), ["claim", "launch"]);
  assert.deepEqual(events[0][1], { issueId: "I_6", viewerId: "U_me", projectId: "PVT_1", itemId: "PVTI_6", fieldId: "F_status", optionId: "O_prog" });
  assert.deepEqual(r.body.claimed, { by: "me", status: "In progress" });
});

test("claim: with the default (agent), nothing is claimed", async () => {
  const events = [];
  const s = createStarter({ root, launch: async () => void events.push(["launch"]), node: "/usr/local/bin/node", claimer: fakeClaimer(events) });
  assert.equal((await s.start(example, 6, { normalized })).status, 200);
  assert.deepEqual(events.map((e) => e[0]), ["launch"]);
});

test("claim: a board without what a claim needs is refused before any write", async () => {
  const events = [];
  const n = normalize({ ...claimableBoard(), statusField: null }, claimExample);
  const r = await claimStarter(events).start(claimExample, 6, { normalized: n });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, "claim");
  assert.match(r.body.error, /cannot be claimed: .*Nothing was launched/);
  assert.deepEqual(events, []);
});

test("claim: a refused claim launches nothing, and a half-landed one is undone exactly", async () => {
  const events = [];
  const half = () => ({ ok: false, assigned: true, statusSet: false, assignees: ["me"], error: "no project scope" });
  const r = await claimStarter(events, { claim: half }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /could not claim #6 on GitHub: no project scope\. The claim was undone\. Nothing was launched\./);
  assert.deepEqual(events.map((e) => e[0]), ["claim", "unclaim"]);
  assert.deepEqual(events[1][2], { ok: false, assigned: true, statusSet: false, assignees: ["me"], error: "no project scope" }, "the undo is told what landed");
  const none = [];
  await claimStarter(none, { claim: () => ({ ok: false, assigned: false, statusSet: false, assignees: null, error: "down" }) }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.deepEqual(none.map((e) => e[0]), ["claim"], "nothing landed, nothing to undo");
});

test("claim: a stranger assigned in the same moment wins; the claim is undone and nothing launches", async () => {
  const events = [];
  const race = () => ({ ok: true, assigned: true, statusSet: true, assignees: ["me", "rival"] });
  const r = await claimStarter(events, { claim: race }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /claimed by rival at the same moment\. The claim was undone\. Nothing was launched/);
  assert.deepEqual(events.map((e) => e[0]), ["claim", "unclaim"]);
});

test("claim: an assignee the page already confirmed is not a rival", async () => {
  const events = [];
  const b = claimableBoard();
  b.nodes.find((x) => x.content?.number === 6).content.assignees = { totalCount: 1, nodes: [{ login: "pal" }] };
  const n = normalize(b, claimExample);
  const s = claimStarter(events, { claim: () => ({ ok: true, assigned: true, statusSet: true, assignees: ["pal", "me"] }) });
  const r = await s.start(claimExample, 6, { normalized: n, confirm: { assigned: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(events.map((e) => e[0]), ["claim", "launch"]);
});

test("claim: a failed launch undoes the claim, and a failed undo says to fix the board by hand", async () => {
  const events = [];
  const boom = async () => { throw new Error("open: not found"); };
  const r = await claimStarter(events, { launch: boom }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /launch failed: open: not found\. The claim was undone\./);
  assert.deepEqual(events.map((e) => e[0]), ["claim", "unclaim"]);
  assert.deepEqual(events[1][1], { removeAssignee: true, restoreStatus: true, clearStatus: false, previousOptionId: "O_todo" });
  const r2 = await claimStarter([], { launch: boom, unclaim: () => ({ ok: false, error: "HTTP 502" }) }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.match(r2.body.error, /Undoing the claim failed too \(HTTP 502\): change the assignee and Status back on GitHub/);
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

test("server start: a claimed start refetches, so the next board load shows In progress, and the board says the claim is on", async (t) => {
  const events = [];
  const before = claimableBoard();
  const after = claimableBoard();
  const node6 = after.nodes.find((x) => x.content?.number === 6);
  node6.status = { name: "In progress" };
  node6.content.assignees = { totalCount: 1, nodes: [{ login: "me" }] };
  const boards = [before, before, after];
  let fetches = 0;
  const fetchBoard = async () => (fetches++, boards.length > 1 ? boards.shift() : boards[0]);
  const a = createApp({ projects: claimProjects, fetchBoard, starter: claimStarter(events) });
  const port = await a.listen(0);
  t.after(() => a.close());
  const host = `127.0.0.1:${port}`;
  const first = await http(port, "/api/board?project=example");
  assert.deepEqual(first.json.start.claim, { status: "In progress" });
  const r = await http(port, "/api/start", { method: "POST", headers: { "content-type": "application/json", origin: `http://${host}`, "sec-fetch-site": "same-origin", "x-mc-nonce": a.nonce }, body: JSON.stringify({ project: "example", number: 6 }) });
  assert.equal(r.status, 200, r.text);
  assert.equal(fetches, 3, "load, refetch before the claim, refetch after it");
  const leaf6 = (await http(port, "/api/board?project=example")).json.layers.flatMap((l) => l.groups.flatMap((g) => g.parts.flatMap((p) => p.leaves))).find((l) => l.number === 6);
  assert.equal(leaf6.state, "inProgress");
  assert.deepEqual(leaf6.assignees, ["me"]);
});
