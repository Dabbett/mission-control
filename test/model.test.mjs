import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProject, loadProjects } from "../src/config.mjs";
import { normalize, leafState, buildSkeleton, issueView, LEAF, PART } from "../src/model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── helpers for synthetic boards ────────────────────────────────────────────

function project(overrides = {}) {
  return validateProject({
    key: "t",
    org: "o",
    projectNumber: 1,
    repo: "o/r",
    localPath: "/tmp/r",
    status: { done: ["Done"], inReview: ["In review"], inProgress: ["In progress"], todo: ["Todo"] },
    prompt: "work #{number}",
    command: ["claude", "{prompt}"],
    layers: [],
    ...overrides,
  });
}

function issue(number, o = {}) {
  const conn = (arr) => ({ totalCount: o[`${arr}Total`] ?? (o[arr] ?? []).length, nodes: o[arr] ?? [] });
  return {
    type: "ISSUE",
    status: o.status === undefined ? { name: "Todo" } : o.status === null ? null : { name: o.status },
    linked: { pullRequests: { totalCount: (o.linked ?? []).length, nodes: o.linked ?? [] } },
    content: {
      __typename: "Issue",
      number,
      title: o.title ?? `Issue ${number}`,
      state: o.state ?? "OPEN",
      stateReason: o.stateReason ?? null,
      url: `https://github.com/o/r/issues/${number}`,
      issueType: o.type ? { name: o.type } : null,
      labels: conn("labels"),
      assignees: conn("assignees"),
      parent: o.parent ? { number: o.parent } : null,
      subIssuesSummary: { total: (o.subIssues ?? []).length, completed: 0 },
      subIssues: conn("subIssues"),
      blockedBy: conn("blockedBy"),
      closedByPullRequestsReferences: conn("closedBy"),
    },
  };
}

function pr(number, o = {}) {
  return {
    number,
    title: o.title ?? `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state: o.state ?? "OPEN",
    isDraft: o.isDraft ?? false,
    commits: { nodes: [{ commit: { statusCheckRollup: o.checks ? { state: o.checks, contexts: { nodes: [] } } : null } }] },
  };
}

function board(nodes) {
  return { title: "B", url: "https://github.com/orgs/o/projects/1", nodes, rateLimit: { cost: 1, remaining: 100, resetAt: "x" }, fetchedAt: "2026-01-01T00:00:00Z" };
}

function state(nodes, number, p = project()) {
  const n = normalize(board(nodes), p);
  return leafState(n.items.get(number), n.items, p);
}

// ── leaf rules ──────────────────────────────────────────────────────────────

test("leaf: closed as not planned is Dropped", () => {
  assert.equal(state([issue(1, { state: "CLOSED", stateReason: "NOT_PLANNED" })], 1).state, LEAF.dropped);
});

test("leaf: closed, or Status in done, is Done", () => {
  assert.equal(state([issue(1, { state: "CLOSED", stateReason: "COMPLETED" })], 1).state, LEAF.done);
  assert.equal(state([issue(1, { status: "Done" })], 1).state, LEAF.done);
});

test("leaf: an on-hold title is Blocked even with no edges", () => {
  const s = state([issue(1, { title: "[On hold] thing" })], 1);
  assert.equal(s.state, LEAF.blocked);
  assert.equal(s.reason, "on hold");
});

test("leaf: an open blocker blocks, a closed one does not", () => {
  const open = state([issue(1, { blockedBy: [{ number: 2, title: "b", state: "OPEN", url: "u" }] })], 1);
  assert.equal(open.state, LEAF.blocked);
  assert.equal(open.blockers[0].number, 2);
  assert.equal(open.reason, "blocked by #2");
  const closed = state([issue(1, { blockedBy: [{ number: 2, title: "b", state: "CLOSED", url: "u" }] })], 1);
  assert.equal(closed.state, LEAF.ready);
});

test("leaf: a Decision blocker is named as such, with its external label from the board", () => {
  const s = state(
    [
      issue(1, { blockedBy: [{ number: 2, title: "d", state: "OPEN", url: "u", issueType: { name: "Decision" } }] }),
      issue(2, { type: "Decision", labels: [{ name: "external: partner" }] }),
    ],
    1,
  );
  assert.equal(s.state, LEAF.blocked);
  assert.equal(s.blockers[0].isDecision, true);
  assert.deepEqual(s.blockers[0].external, ["external: partner"]);
  assert.equal(s.reason, "waiting on decision #2 (external: partner)");
});

test("leaf: an unreadable (null) blocker entry fails closed to Blocked", () => {
  const s = state([issue(1, { blockedBy: [null] })], 1);
  assert.equal(s.state, LEAF.blocked);
  assert.match(s.reason, /could not be read/);
});

test("leaf: a truncated blocker list fails closed to Blocked", () => {
  const s = state([issue(1, { blockedBy: [], blockedByTotal: 3 })], 1);
  assert.equal(s.state, LEAF.blocked);
  assert.match(s.reason, /truncated/);
});

test("leaf: In review from Status or from an open non-draft PR", () => {
  assert.equal(state([issue(1, { status: "In review" })], 1).state, LEAF.inReview);
  assert.equal(state([issue(1, { linked: [pr(9)] })], 1).state, LEAF.inReview);
});

test("leaf: In progress from Status or from an open draft PR", () => {
  assert.equal(state([issue(1, { status: "In progress" })], 1).state, LEAF.inProgress);
  assert.equal(state([issue(1, { closedBy: [pr(9, { isDraft: true })] })], 1).state, LEAF.inProgress);
});

test("leaf: a merged PR does not make an open issue In progress", () => {
  assert.equal(state([issue(1, { linked: [pr(9, { state: "MERGED" })] })], 1).state, LEAF.ready);
});

test("leaf: an open Decision is never Ready", () => {
  assert.equal(state([issue(1, { type: "Decision" })], 1).state, LEAF.decision);
});

test("leaf: a blocked Decision is Blocked (blocked wins over decision)", () => {
  assert.equal(state([issue(1, { type: "Decision", blockedBy: [{ number: 2, state: "OPEN", title: "x", url: "u" }] })], 1).state, LEAF.blocked);
});

test("leaf: no status at all and nothing else is Ready", () => {
  assert.equal(state([issue(1, { status: null })], 1).state, LEAF.ready);
});

test("leaf: custom status option names map through config", () => {
  const p = project({ status: { done: ["shipped"], inReview: ["verifying"], inProgress: ["doing"], todo: ["queued"] } });
  assert.equal(state([issue(1, { status: "verifying" })], 1, p).state, LEAF.inReview);
  assert.equal(state([issue(1, { status: "shipped" })], 1, p).state, LEAF.done);
  assert.equal(state([issue(1, { status: "queued" })], 1, p).state, LEAF.ready);
});

// ── parts ───────────────────────────────────────────────────────────────────

function skeletonFor(nodes, parts, extra = {}) {
  const p = project({ layers: [{ name: "L", groups: [{ name: "G", ...extra, parts }] }] });
  return { p, s: buildSkeleton(normalize(board(nodes), p), p) };
}

function part(s, name) {
  return s.layers[0].groups[0].parts.find((x) => x.name === name);
}

test("part: no leaves is Not started with no percentage", () => {
  const { s } = skeletonFor([], [{ name: "P", issues: [] }]);
  assert.equal(part(s, "P").state, PART.notStarted);
  assert.equal(part(s, "P").counts.percent, null);
});

test("part: only dropped leaves is All dropped, not Not started", () => {
  const { s } = skeletonFor([issue(1, { state: "CLOSED", stateReason: "NOT_PLANNED" })], [{ name: "P", issues: [1] }]);
  assert.equal(part(s, "P").state, PART.allDropped);
  assert.equal(part(s, "P").counts.dropped, 1);
  assert.equal(part(s, "P").counts.total, 0);
});

test("part: every leaf done is Done, dropped leaves leave the denominator", () => {
  const { s } = skeletonFor([issue(1, { state: "CLOSED", stateReason: "COMPLETED" }), issue(2, { state: "CLOSED", stateReason: "NOT_PLANNED" })], [{ name: "P", issues: [1, 2] }]);
  assert.equal(part(s, "P").state, PART.done);
  assert.deepEqual([part(s, "P").counts.done, part(s, "P").counts.total, part(s, "P").counts.percent], [1, 1, 100]);
});

test("part: In progress beats Ready, Ready beats Blocked, all blocked is Blocked", () => {
  const ip = skeletonFor([issue(1, { status: "In progress" }), issue(2)], [{ name: "P", issues: [1, 2] }]).s;
  assert.equal(part(ip, "P").state, PART.inProgress);
  assert.equal(part(ip, "P").counts.ready, 1);
  const rd = skeletonFor([issue(1, { title: "[On hold] x" }), issue(2)], [{ name: "P", issues: [1, 2] }]).s;
  assert.equal(part(rd, "P").state, PART.ready);
  const bl = skeletonFor([issue(1, { title: "[On hold] x" }), issue(2, { blockedBy: [{ number: 1, state: "OPEN", title: "x", url: "u" }] })], [{ name: "P", issues: [1, 2] }]).s;
  assert.equal(part(bl, "P").state, PART.blocked);
});

test("part: a non-epic parent and its child are both leaves", () => {
  const { s } = skeletonFor([issue(1, { state: "CLOSED", stateReason: "COMPLETED", subIssues: [{ number: 2 }] }), issue(2, { parent: 1 })], [{ name: "P", issues: [1, 2] }]);
  assert.deepEqual([part(s, "P").counts.done, part(s, "P").counts.total], [1, 2]);
  assert.equal(part(s, "P").state, PART.ready);
});

test("part: an epic listed in a part expands to its children and is not itself a leaf", () => {
  const nodes = [issue(10, { labels: [{ name: "epic" }], subIssues: [{ number: 1 }, { number: 2 }] }), issue(1, { state: "CLOSED", stateReason: "COMPLETED" }), issue(2)];
  const { s } = skeletonFor(nodes, [{ name: "P", issues: [10] }]);
  assert.deepEqual(part(s, "P").leaves.map((l) => l.number), [1, 2]);
  assert.deepEqual([part(s, "P").counts.done, part(s, "P").counts.total], [1, 2]);
});

test("part: decisions listed in a part are display only", () => {
  const { s } = skeletonFor([issue(1), issue(2, { type: "Decision" })], [{ name: "P", issues: [1, 2] }]);
  assert.equal(part(s, "P").leaves.length, 1);
  assert.equal(part(s, "P").decisions[0].number, 2);
  assert.equal(part(s, "P").state, PART.ready);
  assert.equal(s.decisions.open[0].number, 2);
  assert.equal(s.unsorted.open.length, 0);
});

test("multi-part membership counts per part but once in totals", () => {
  const p = project({ layers: [{ name: "L", groups: [{ name: "G", parts: [{ name: "A", issues: [1] }, { name: "B", issues: [1] }] }] }] });
  const s = buildSkeleton(normalize(board([issue(1)]), p), p);
  assert.equal(s.layers[0].groups[0].parts[0].counts.total, 1);
  assert.equal(s.layers[0].groups[0].parts[1].counts.total, 1);
  assert.equal(s.totals.total, 1);
});

test("unsorted: unclaimed open items, closed behind the toggle, PRs that close nothing, drafts; never decisions or epics", () => {
  const nodes = [
    issue(1),
    issue(2, { state: "CLOSED", stateReason: "COMPLETED" }),
    issue(3, { type: "Decision" }),
    issue(4, { labels: [{ name: "epic" }] }),
    { type: "PULL_REQUEST", status: { name: "Done" }, content: { __typename: "PullRequest", ...pr(50, { state: "MERGED" }) } },
    { type: "DRAFT_ISSUE", status: { name: "Todo" }, content: { __typename: "DraftIssue", title: "draft" } },
  ];
  const { s } = skeletonFor(nodes, [{ name: "P", issues: [] }]);
  assert.deepEqual(s.unsorted.open.map((x) => x.number), [1]);
  assert.deepEqual(s.unsorted.closed.map((x) => x.number), [2]);
  assert.deepEqual(s.unsorted.prs.map((x) => x.number), [50]);
  assert.deepEqual(s.unsorted.drafts.map((x) => x.title), ["draft"]);
});

test("drift: config numbers missing from the board, and epic children claimed by no part", () => {
  const nodes = [issue(10, { labels: [{ name: "epic" }], subIssues: [{ number: 1 }, { number: 2 }] }), issue(1), issue(2, { state: "CLOSED", stateReason: "COMPLETED" })];
  const { s } = skeletonFor(nodes, [{ name: "P", issues: [1, 999] }], { epic: 10 });
  assert.deepEqual(s.drift, [
    { kind: "missing", number: 999, part: "L / G / P" },
    { kind: "unclaimed", number: 2, epic: 10 },
  ]);
});

test("truncated connections are reported per item", () => {
  const { s } = skeletonFor([issue(1, { labels: [], labelsTotal: 30 })], [{ name: "P", issues: [1] }]);
  assert.deepEqual(s.truncated, [{ number: 1, fields: ["labels"] }]);
});

test("decisions carry what they block", () => {
  const nodes = [issue(1, { blockedBy: [{ number: 2, state: "OPEN", title: "d", url: "u", issueType: { name: "Decision" } }] }), issue(2, { type: "Decision" })];
  const { s } = skeletonFor(nodes, [{ name: "P", issues: [1] }]);
  assert.deepEqual(s.decisions.open[0].blocks, [1]);
});

// ── the synthetic board (test/fixtures/board-example.json) ──────────────────

const fixture = JSON.parse(readFileSync(join(root, "test", "fixtures", "board-example.json"), "utf8"));
const example = loadProjects(join(root, "projects")).get("example");
const live = normalize({ ...fixture, fetchedAt: fixture.recordedAt }, example);
const sk = buildSkeleton(live, example);

function findPart(name) {
  for (const l of sk.layers) for (const g of l.groups) for (const p of g.parts) if (p.name === name) return p;
  throw new Error(`no part ${name}`);
}

test("fixture: #36 is Blocked by Decision #28 with the external label", () => {
  const v = issueView(live, example, 36);
  assert.equal(v.state, LEAF.blocked);
  assert.equal(v.blockers[0].number, 28);
  assert.equal(v.blockers[0].isDecision, true);
  assert.deepEqual(v.blockers[0].external, ["external: partner"]);
});

test("fixture: #7 is Blocked by #33; #62 is on hold; #6 is Ready", () => {
  assert.equal(issueView(live, example, 7).reason, "blocked by #33");
  assert.equal(issueView(live, example, 62).reason, "on hold");
  assert.equal(issueView(live, example, 6).state, LEAF.ready);
});

test("fixture: #49 sits in Unsorted; Decisions are their own layer", () => {
  assert.ok(sk.unsorted.open.some((x) => x.number === 49));
  assert.deepEqual(sk.decisions.open.map((d) => d.number), [4, 27, 28, 29, 44, 46, 61]);
  assert.deepEqual(sk.decisions.closed.map((d) => d.number), [30]);
  assert.ok(!sk.unsorted.open.some((x) => x.type === "Decision"));
});

test("fixture: Core reads 6/9 with #13 dropped; API 1/3; Permissions 2/3", () => {
  const core = sk.layers.find((l) => l.name === "Core").groups[0];
  assert.deepEqual([core.counts.done, core.counts.total, core.counts.dropped], [6, 9, 1]);
  assert.deepEqual([findPart("API").counts.done, findPart("API").counts.total], [1, 3]);
  assert.deepEqual([findPart("Permissions").counts.done, findPart("Permissions").counts.total], [2, 3]);
  assert.equal(findPart("Permissions").decisions[0].number, 46);
  assert.equal(findPart("Data model and storage").state, PART.done);
  assert.equal(findPart("Data model and storage").leaves.find((l) => l.number === 13).state, LEAF.dropped);
});

test("fixture: Mobile Browse 0/2 Ready, Home Not started, Admin Shell Done", () => {
  assert.deepEqual([findPart("Browse").counts.done, findPart("Browse").counts.total, findPart("Browse").state], [0, 2, PART.ready]);
  assert.equal(findPart("Home").state, PART.notStarted);
  assert.equal(findPart("Shell").state, PART.done);
});

test("fixture: no drift and no truncation on the synthetic board", () => {
  assert.deepEqual(sk.drift, []);
  assert.deepEqual(sk.truncated, []);
});

test("fixture: merged PRs show SUCCESS checks and the four PR items close nothing", () => {
  const v = issueView(live, example, 5);
  assert.equal(v.prs[0].number, 37);
  assert.equal(v.prs[0].checks, "SUCCESS");
  assert.deepEqual(sk.unsorted.prs.map((p) => p.number).sort((a, b) => a - b), [45, 47, 57, 60]);
});

// ── status names and unknown Status ─────────────────────────────────────────

test("leaf: Status names match after trimming and lower-casing", () => {
  const p = project();
  assert.equal(state([issue(1, { status: "DONE " })], 1, p).state, LEAF.done);
  assert.equal(state([issue(1, { status: " in Review" })], 1, p).state, LEAF.inReview);
  assert.equal(state([issue(1, { status: "in progress" })], 1, p).state, LEAF.inProgress);
  assert.equal(state([issue(1, { status: "todo" })], 1, p).state, LEAF.ready);
});

test("skeleton: a Status in none of the lists counts as Ready, marks the leaf, and shows as config drift", () => {
  const p = project({ layers: [{ name: "L", groups: [{ name: "G", parts: [{ name: "P", issues: [1, 2, 3] }] }] }] });
  const n = normalize(board([issue(1, { status: "Backlog" }), issue(2, { status: "Backlog" }), issue(3, { status: "Todo" }), issue(4, { status: null })]), p);
  const sk = buildSkeleton(n, p);
  const part = sk.layers[0].groups[0].parts[0];
  assert.deepEqual(part.leaves.map((l) => [l.number, l.state, l.statusKnown]), [[1, LEAF.ready, false], [2, LEAF.ready, false], [3, LEAF.ready, true]]);
  assert.deepEqual(sk.drift, [{ kind: "unknownStatus", name: "Backlog", count: 2 }], "one chip per unknown name, with a count; no Status at all is not drift");
  assert.equal(issueView(n, p, 1).statusKnown, false);
  assert.equal(issueView(n, p, 4).statusKnown, true);
});

test("skeleton: unknown-Status drift counts only issues it makes Ready, not closed issues, epics or blocked ones", () => {
  const p = project({ layers: [{ name: "L", groups: [{ name: "G", parts: [{ name: "P", issues: [1, 2, 3, 4] }] }] }] });
  const n = normalize(board([
    issue(1, { status: "Archived" }),
    issue(2, { status: "Archived", state: "CLOSED", stateReason: "COMPLETED" }),
    issue(3, { status: "Archived", labels: [{ name: "epic" }] }),
    issue(4, { status: "Archived", title: "[On hold] later" }),
  ]), p);
  assert.deepEqual(buildSkeleton(n, p).drift, [{ kind: "unknownStatus", name: "Archived", count: 1 }]);
});

test("leaf: onHoldPattern null turns the on-hold rule off", () => {
  assert.equal(state([issue(1, { title: "[On hold] x" })], 1, project({ onHoldPattern: null })).state, LEAF.ready);
  assert.equal(state([issue(1, { title: "[On hold] x" })], 1).state, LEAF.blocked, "the default pattern still applies");
});
