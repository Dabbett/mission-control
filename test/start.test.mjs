import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createStarter, childEnv, CHILD_ENV_KEYS, worktreePath } from "../src/start.mjs";
import { lockIssue, readRecord, writeRecord } from "../src/sessions.mjs";
import { createApp } from "../src/server.mjs";
import { normalize } from "../src/model.mjs";
import { root, exampleProjects, fixtureBoard, claimableBoard, http } from "./helpers.mjs";

// The example's localPath does not exist on any machine, and Start refuses a missing checkout, so point it at this repo.
const projects = exampleProjects({ start: { enabled: true }, localPath: root });
const example = projects.get("example");
const normalized = normalize(fixtureBoard(), example);

const stateDir = () => mkdtempSync(join(tmpdir(), "mc-sessions-"));
const recordOf = (argv) => argv[argv.indexOf("--record") + 1];

/** What the launcher does to the record over a whole session that ended with status 0, so a later Start sees "exited". */
function endSession(argv) {
  const path = recordOf(argv);
  writeRecord(path, { ...readRecord(path), pid: 1, startedAt: "2023-11-14T22:13:21.000Z", exitedAt: "2023-11-14T22:30:00.000Z", exitCode: 0, signal: null });
}

function starter(opts = {}) {
  const launches = [];
  const dir = opts.stateDir ?? stateDir();
  const launch = opts.launch ?? (async (argv) => (launches.push(argv), endSession(argv)));
  const s = createStarter({ root, stateDir: dir, launch, now: () => 1_700_000_000_000, node: "/usr/local/bin/node", alive: opts.alive ?? (async () => true), worktreeStatus: opts.worktreeStatus });
  return { s, launches, dir };
}

test("start: a Ready issue launches Ghostty with an argv-only command and absolute paths", async () => {
  const { s, launches, dir } = starter();
  const r = await s.start(example, 6, { normalized });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(launches.length, 1);
  const argv = launches[0];
  assert.deepEqual(argv.slice(0, 5), ["-na", "Ghostty.app", "--args", "--quit-after-last-window-closed=true", "-e"]);
  assert.equal(argv[5], "/usr/local/bin/node");
  assert.equal(argv[6], join(root, "bin", "launch.mjs"));
  assert.ok(isAbsolute(argv[6]));
  assert.deepEqual(argv.slice(7, 9), ["--cwd", example.localPath]);
  assert.ok(isAbsolute(example.localPath));
  assert.equal(argv[9], "--record");
  assert.equal(argv[10], join(dir, `example-6-${r.body.sessionId}.json`));
  assert.equal(argv[11], "--");
  assert.deepEqual(argv.slice(12, 19), ["claude", "--model", "opus", "-w", "issue-6", "--name", "example#6"]);
  assert.match(argv[19], /^Read AGENTS\.md, then plan and work issue #6/);
  assert.equal(argv.length, 20);
  for (const a of argv) assert.ok(!/[\r\n]/.test(a));
  assert.equal(r.body.model, "opus");
  assert.deepEqual((await s.sessionsFor("example")).byNumber[6].launchedAt, "2023-11-14T22:13:20.000Z");
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
  assert.deepEqual(launches[0].slice(12, 15), ["claude", "--model", "sonnet"]);
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

test("start: a repeat after the session ended needs confirm, also from a new server on the same records", async () => {
  const { s, launches, dir } = starter();
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
  const restarted = starter({ stateDir: dir });
  assert.deepEqual((await restarted.s.start(example, 6, { normalized })).body.requiresConfirm, ["started"], "the record outlives the server");
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

test("start: a failed launch reports and leaves no session record", async () => {
  const { s, dir } = starter({ launch: async () => { throw new Error("open: not found"); } });
  const r = await s.start(example, 6, { normalized });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /launch failed: open: not found/);
  assert.deepEqual(readdirSync(dir), []);
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
  assert.deepEqual((await s.sessionsFor("example")).byNumber, {});
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
  const launch = opts.launch ?? (async (argv) => void events.push(["launch", argv[12]]));
  return createStarter({ root, stateDir: stateDir(), launch, now: () => 1_700_000_000_000, node: "/usr/local/bin/node", claimer: fakeClaimer(events, opts) });
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
  const s = createStarter({ root, stateDir: stateDir(), launch: async () => void events.push(["launch"]), node: "/usr/local/bin/node", claimer: fakeClaimer(events) });
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
  assert.equal(r.body.wrote, undefined, "no write went out, so the server has nothing to refetch for");
  assert.deepEqual(events, []);
});

test("claim: a refused claim launches nothing, and a half-landed one is undone exactly", async () => {
  const events = [];
  const half = () => ({ ok: false, assigned: true, statusSet: false, assignees: ["me"], error: "no project scope" });
  const r = await claimStarter(events, { claim: half }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /could not claim #6 on GitHub: no project scope\. Your part of the claim was undone\. Nothing was launched\./);
  assert.deepEqual(events.map((e) => e[0]), ["claim", "unclaim"]);
  assert.deepEqual(events[1][2], { ok: false, assigned: true, statusSet: false, assignees: ["me"], error: "no project scope" }, "the undo is told what landed");
  const none = [];
  await claimStarter(none, { claim: () => ({ ok: false, assigned: false, statusSet: false, assignees: null, error: "down" }) }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.deepEqual(none.map((e) => e[0]), ["claim"], "nothing landed, nothing to undo");
  const lost = [];
  const r3 = await claimStarter(lost, { claim: () => ({ ok: false, assigned: false, statusSet: false, assignees: null, unknown: true, error: "GitHub did not answer within 15 s" }) }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.deepEqual(lost.map((e) => e[0]), ["claim", "unclaim"], "an answer that never came may hide a claim that landed: undo it all");
  assert.deepEqual(lost[1][2], { assigned: true, statusSet: false }, "a lost answer takes back the assignee only: a rival may hold the Status now");
  assert.match(r3.body.error, /may have landed before the answer was lost; if #6 now shows In progress and nobody is working on it, set its Status back/);
  assert.equal(r3.body.wrote, true);
});

test("claim: a stranger assigned in the same moment wins; the claim is undone and nothing launches", async () => {
  const events = [];
  const race = () => ({ ok: true, assigned: true, statusSet: true, assignees: ["me", "rival"] });
  const r = await claimStarter(events, { claim: race }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /claimed by rival at the same moment\. Your part of the claim was undone\. Its Status stays In progress, in case their session started; if nobody is working on it, set the Status back on GitHub\. Nothing was launched/);
  assert.deepEqual(events.map((e) => e[0]), ["claim", "unclaim"]);
  assert.deepEqual(events[1][2], { assigned: true, statusSet: false }, "the loser takes back its assignee only; the winner's In progress stays");
});

test("claim: a claim reply without its assignee list cannot rule out a rival, so it backs off the same way", async () => {
  const events = [];
  const blind = () => ({ ok: true, assigned: true, statusSet: true, assignees: null });
  const r = await claimStarter(events, { claim: blind }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /did not return its assignees/);
  assert.deepEqual(events[1][2], { assigned: true, statusSet: false });
  assert.ok(!events.some((e) => e[0] === "launch"));
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
  assert.match(r.body.error, /launch failed: open: not found\. Your part of the claim was undone\./);
  assert.deepEqual(events.map((e) => e[0]), ["claim", "unclaim"]);
  assert.deepEqual(events[1][1], { removeAssignee: true, restoreStatus: true, clearStatus: false, previousOptionId: "O_todo" });
  const r2 = await claimStarter([], { launch: boom, unclaim: () => ({ ok: false, error: "HTTP 502" }) }).start(claimExample, 6, { normalized: normalize(claimableBoard(), claimExample) });
  assert.match(r2.body.error, /Undoing the claim failed too \(HTTP 502\): check the assignee and Status on GitHub and change them back by hand/);
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
  assert.deepEqual(before.json.start.sessions, {});
  assert.equal(before.json.start.running, 0);
  const r = await post({ project: "example", number: 6 });
  assert.equal(r.status, 200, r.text);
  assert.equal(launches.length, 1);
  assert.equal(fetchCount(), 2, "start refetches before launching");
  const after = await http(port, "/api/board?project=example");
  assert.equal(after.json.start.sessions[6].state, "exited");
  assert.equal(after.json.start.running, 0);
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
  const { post } = await app(t, { launch: async (argv) => (launches.push(argv), await gate, endSession(argv)) });
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

// ── session records (ADR 0003) ────────────────────────────────────────────────

test("start: a running or starting session is refused outright, whatever is confirmed", async () => {
  const all = { started: true, assigned: true, worktree: true };
  const { s, launches, dir } = starter({ launch: async (argv) => void launches.push(argv) });
  assert.equal((await s.start(example, 6, { normalized })).status, 200);
  const starting = await s.start(example, 6, { normalized, confirm: all });
  assert.equal(starting.status, 409);
  assert.equal(starting.body.reason, "running");
  assert.match(starting.body.error, /#6 has a session launched at .* that has not opened yet on this machine/);
  const path = recordOf(launches[0]);
  writeRecord(path, { ...readRecord(path), pid: 4242, startedAt: "2023-11-14T22:13:21.000Z" });
  const running = await s.start(example, 6, { normalized, confirm: all });
  assert.equal(running.body.reason, "running");
  assert.match(running.body.error, /running since 2023-11-14T22:13:21\.000Z on this machine\. Close its window first/);
  const other = starter({ stateDir: dir, launch: async (argv) => void launches.push(argv) });
  assert.equal((await other.s.start(example, 6, { normalized, confirm: all })).body.reason, "running", "a second server sees it too");
  assert.equal(launches.length, 1);
  const board = await s.sessionsFor("example");
  assert.equal(board.byNumber[6].state, "running");
  assert.equal(board.running, 1);
});

test("start: a launcher that died without an end, or never ran, counts as ended: confirm, not refuse", async () => {
  const { s, launches } = starter({ launch: async (argv) => void launches.push(argv), alive: async () => false });
  assert.equal((await s.start(example, 6, { normalized })).status, 200);
  const path = recordOf(launches[0]);
  writeRecord(path, { ...readRecord(path), pid: 4242, startedAt: "2023-11-14T22:13:21.000Z" });
  const r = await s.start(example, 6, { normalized });
  assert.deepEqual(r.body.requiresConfirm, ["started"]);
  assert.equal(r.body.session.state, "ended");
  let t = 1_700_000_000_000;
  const later = createStarter({ root, stateDir: mkdtempSync(join(tmpdir(), "mc-sessions-")), launch: async () => {}, now: () => t, node: "/usr/local/bin/node" });
  assert.equal((await later.start(example, 6, { normalized })).status, 200);
  t += 61_000; // the launcher never took the record over
  const never = await later.start(example, 6, { normalized });
  assert.deepEqual(never.body.requiresConfirm, ["started"]);
  assert.equal(never.body.session.note, "the launcher never ran");
});

test("start: another mission control holding the issue's lock is a 429; a lock left by a crash expires", async () => {
  const { s, dir, launches } = starter();
  const release = lockIssue(dir, "example", 6, 1_700_000_000_000);
  assert.ok(release);
  const r = await s.start(example, 6, { normalized });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /another mission control on this machine/);
  release();
  assert.equal((await s.start(example, 6, { normalized, confirm: {} })).status, 200);
  assert.equal(launches.length, 1);
  assert.ok(lockIssue(dir, "example", 7, 1_700_000_000_000));
  assert.equal(lockIssue(dir, "example", 7, 1_700_000_000_000), null);
  assert.ok(lockIssue(dir, "example", 7, Date.now() + 10 * 60_000), "stale after LOCK_STALE_MS");
});

test("start: a leftover worktree with uncommitted changes needs its own confirm and names the path", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mc-repo-"));
  const wt = join(repo, ".claude", "worktrees", "issue-6");
  mkdirSync(wt, { recursive: true });
  const git = (...a) => assert.equal(spawnSync("git", ["-C", wt, ...a], { encoding: "utf8" }).status, 0);
  git("init", "-q");
  const local = { ...example, localPath: repo };
  const clean = starter();
  assert.equal((await clean.s.start(local, 6, { normalized })).status, 200, "a clean worktree is no reason");
  writeFileSync(join(wt, "half-done.txt"), "x");
  const { s, launches } = starter();
  const r = await s.start(local, 6, { normalized });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.requiresConfirm, ["worktree"]);
  assert.equal(r.body.worktree, wt);
  assert.match(r.body.error, new RegExp(`#6 has uncommitted changes in its worktree ${wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal((await s.start(local, 6, { normalized, confirm: { started: true, assigned: true } })).status, 409, "other confirms do not pass");
  assert.equal((await s.start(local, 6, { normalized, confirm: { worktree: true } })).status, 200);
  assert.equal(launches.length, 1);
  const broken = await starter({ worktreeStatus: async () => ({ error: "git could not read it" }) }).s.start(local, 6, { normalized });
  assert.match(broken.body.error, /has a worktree at .* that git could not read it/);
});

test("start: the worktree path comes from -w/--worktree in the rendered command, and an odd name is not checked", () => {
  const p = { localPath: "/r" };
  assert.equal(worktreePath(p, ["claude", "-w", "issue-6", "x"]), "/r/.claude/worktrees/issue-6");
  assert.equal(worktreePath(p, ["claude", "--worktree", "a.b"]), "/r/.claude/worktrees/a.b");
  assert.equal(worktreePath(p, ["claude", "--worktree=w1"]), "/r/.claude/worktrees/w1");
  assert.equal(worktreePath(p, ["claude", "-w", "--name", "x"]), null, "-w with no name: claude picks one");
  assert.equal(worktreePath(p, ["claude", "-w", ".."]), null);
  assert.equal(worktreePath(p, ["claude", "-w", "a/b"]), null);
  assert.equal(worktreePath(p, ["claude", "x"]), null);
});

test("server start: the board lists the newest session per issue and counts the running ones", async (t) => {
  const launches = [];
  const { port, post } = await app(t, { launch: async (argv) => void launches.push(argv) });
  assert.equal((await post({ project: "example", number: 6 })).status, 200);
  const path = recordOf(launches[0]);
  writeRecord(path, { ...readRecord(path), pid: 4242, startedAt: "2023-11-14T22:13:21.000Z" });
  const b = (await http(port, "/api/board?project=example")).json;
  assert.equal(b.start.sessions[6].state, "running");
  assert.equal(b.start.running, 1);
  const refused = await post({ project: "example", number: 6, confirm: { started: true } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.reason, "running");
  assert.equal(launches.length, 1);
});

test("start: a plain folder where the worktree should be is not read through the checkout around it", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mc-repo-"));
  assert.equal(spawnSync("git", ["-C", repo, "init", "-q"]).status, 0);
  writeFileSync(join(repo, "main-checkout-change.txt"), "x"); // the checkout around it is dirty
  const wt = join(repo, ".claude", "worktrees", "issue-6");
  mkdirSync(wt, { recursive: true });
  const r = await starter().s.start({ ...example, localPath: repo }, 6, { normalized });
  assert.deepEqual(r.body.requiresConfirm, ["worktree"]);
  assert.match(r.body.error, /has a worktree at .*issue-6 that is not a git worktree of its own/);
});

test("server start: an unreadable session dir leaves the board up and says so", async (t) => {
  const s = { start: async () => ({ status: 500, body: {} }), sessionsFor: async () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } };
  const a = createApp({ projects, fetchBoard: async () => fixtureBoard(), starter: s });
  const port = await a.listen(0);
  t.after(() => a.close());
  const b = await http(port, "/api/board?project=example");
  assert.equal(b.status, 200);
  assert.deepEqual(b.json.start.sessions, {});
  assert.equal(b.json.start.sessionsError, "session records could not be read (EACCES)");
});

test("start: a lock is removed only by its holder", () => {
  const dir = stateDir();
  const releaseOld = lockIssue(dir, "example", 8, 1_700_000_000_000);
  const releaseNew = lockIssue(dir, "example", 8, Date.now() + 10 * 60_000); // took the stale lock over
  assert.ok(releaseNew);
  releaseOld(); // the first Start finally finishes
  assert.equal(lockIssue(dir, "example", 8, Date.now()), null, "the new holder's lock survived");
  releaseNew();
  assert.ok(lockIssue(dir, "example", 8, Date.now()));
});
