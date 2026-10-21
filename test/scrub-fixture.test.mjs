import test from "node:test";
import assert from "node:assert/strict";
import { scrubFixture, EXAMPLE } from "../scripts/scrub-fixture.mjs";

// A small recorded board with every kind of text the scrub must remove, in the shape fetchBoard returns.
const checks = { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ name: "acme-ci", conclusion: "SUCCESS", status: "COMPLETED" }, { name: "acme-lint", conclusion: "SUCCESS", status: "COMPLETED" }] } } } }] };
const pr = { number: 210, title: "feat: the widget (#200)", url: "https://github.com/Acme-Corp/secret-app/pull/210", state: "MERGED", isDraft: false, commits: checks };
function recorded() {
  return {
    recordedAt: "2026-03-04T05:06:07.000Z",
    project: { key: "acme", org: "Acme-Corp", projectNumber: 9, title: "Secret Product", url: "https://github.com/orgs/Acme-Corp/projects/9" },
    rateLimit: { cost: 3 },
    nodes: [
      {
        id: "PVTI_1", type: "ISSUE", status: { name: "Backlog" }, linked: null,
        content: {
          __typename: "Issue", number: 200, title: "Build the widget for Globex", state: "OPEN", stateReason: null,
          url: "https://github.com/Acme-Corp/secret-app/issues/200", updatedAt: "2026-03-01T00:00:00Z", issueType: { name: "Spike" },
          labels: { totalCount: 3, nodes: [{ name: "epic" }, { name: "external: Globex" }, { name: "needs-legal" }] },
          assignees: { totalCount: 1, nodes: [{ login: "realperson" }] }, parent: null,
          subIssuesSummary: { total: 1, completed: 0 }, subIssues: { totalCount: 1, nodes: [{ number: 201 }] },
          blockedBy: { totalCount: 1, nodes: [{ number: 202, title: "Decide the pricing", state: "OPEN", url: "https://github.com/Acme-Corp/secret-app/issues/202", issueType: { name: "Call" } }] },
          closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
        },
      },
      {
        id: "PVTI_2", type: "ISSUE", status: { name: "Shipped" }, linked: { pullRequests: { totalCount: 1, nodes: [pr] } },
        content: {
          __typename: "Issue", number: 201, title: "[On hold] Ship the widget", state: "CLOSED", stateReason: "COMPLETED",
          url: "https://github.com/Acme-Corp/secret-app/issues/201", updatedAt: "2026-03-02T00:00:00Z", issueType: { name: "Task" },
          labels: { totalCount: 1, nodes: [{ name: "Model:Sonnet" }] }, assignees: { totalCount: 0, nodes: [] }, parent: { number: 200 },
          subIssuesSummary: { total: 0, completed: 0 }, subIssues: { totalCount: 0, nodes: [] }, blockedBy: { totalCount: 0, nodes: [] },
          closedByPullRequestsReferences: { totalCount: 1, nodes: [pr] },
        },
      },
      { id: "PVTI_3", type: "PULL_REQUEST", status: { name: "Shipped" }, linked: null, content: { __typename: "PullRequest", ...pr, updatedAt: "2026-03-03T00:00:00Z" } },
    ],
  };
}
const options = { status: { done: ["Shipped"], inReview: [], inProgress: [], todo: ["Backlog"] }, decisionType: "Call" };

test("scrub: numbers shift so the lowest is 1, in every place a number appears", () => {
  const { fixture, offset } = scrubFixture(recorded(), options);
  assert.equal(offset, 199);
  const [a, b, c] = fixture.nodes.map((n) => n.content);
  assert.deepEqual([a.number, b.number, c.number], [1, 2, 11]);
  assert.deepEqual(a.subIssues.nodes, [{ number: 2 }]);
  assert.equal(b.parent.number, 1);
  assert.equal(a.blockedBy.nodes[0].number, 3);
  assert.equal(fixture.nodes[1].linked.pullRequests.nodes[0].number, 11);
  assert.equal(b.closedByPullRequestsReferences.nodes[0].number, 11);
});

test("scrub: titles become Item N or PR N, keeping [On hold]; URLs move to the example repo", () => {
  const { fixture } = scrubFixture(recorded(), options);
  const [a, b, c] = fixture.nodes.map((n) => n.content);
  assert.equal(a.title, "Item 1");
  assert.equal(b.title, "[On hold] Item 2");
  assert.equal(c.title, "PR 11");
  assert.equal(a.blockedBy.nodes[0].title, "Item 3");
  assert.equal(fixture.nodes[1].linked.pullRequests.nodes[0].title, "PR 11");
  assert.equal(a.url, `https://github.com/${EXAMPLE.repo}/issues/1`);
  assert.equal(c.url, `https://github.com/${EXAMPLE.repo}/pull/11`);
  assert.equal(a.blockedBy.nodes[0].url, `https://github.com/${EXAMPLE.repo}/issues/3`);
  assert.deepEqual(fixture.project, { key: "example", org: "example-org", projectNumber: 1, title: "Example", url: "https://github.com/orgs/example-org/projects/1" });
});

test("scrub: labels, logins, check names, Status and issue types turn generic; config-meaningful names survive", () => {
  const { fixture } = scrubFixture(recorded(), options);
  const [a, b] = fixture.nodes.map((n) => n.content);
  assert.deepEqual(a.labels.nodes.map((l) => l.name), ["epic", "external: partner", "label-1"]);
  assert.deepEqual(b.labels.nodes.map((l) => l.name), ["Model:Sonnet"], "a model label keeps its meaning");
  assert.deepEqual(a.assignees.nodes, [{ login: "user1" }]);
  assert.deepEqual(fixture.nodes[1].linked.pullRequests.nodes[0].commits.nodes[0].commit.statusCheckRollup.contexts.nodes.map((c) => c.name), ["check-1", "check-2"]);
  assert.deepEqual(fixture.nodes.map((n) => n.status.name), ["Todo", "Done", "Done"], "Status options named in the config map to their group's name");
  assert.equal(a.issueType.name, "Type 1", "a custom issue type turns generic");
  assert.equal(b.issueType.name, "Task", "a GitHub default type stays");
  assert.equal(a.blockedBy.nodes[0].issueType.name, "Decision", "the configured decision type becomes Decision");
  assert.ok(fixture.nodes.every((n) => n.id === undefined), "node ids are dropped");
  assert.equal(new Set(fixture.nodes.map((n) => n.content.updatedAt)).size, 1, "timestamps are flattened");
  assert.notEqual(fixture.recordedAt, "2026-03-04T05:06:07.000Z");
});

test("scrub: without a status config, unknown Status names turn generic too", () => {
  const { fixture } = scrubFixture(recorded(), { decisionType: "Call" });
  assert.deepEqual(fixture.nodes.map((n) => n.status.name), ["Status 1", "Status 2", "Status 2"]);
});

test("scrub: no word of the recorded board survives", () => {
  const text = JSON.stringify(scrubFixture(recorded(), options).fixture);
  for (const word of ["Acme", "Globex", "widget", "realperson", "acme-ci", "Spike", "Call", "Backlog", "Shipped", "secret", "needs-legal", "pricing", "2026-03"]) {
    assert.ok(!text.toLowerCase().includes(word.toLowerCase()), `${word} survived`);
  }
});

test("scrub: forbid refuses a fixture that still holds a string or matches a pattern", () => {
  assert.doesNotThrow(() => scrubFixture(recorded(), { ...options, forbid: ["Acme-Corp", "secret-app", "Secret Product", /globex/i] }));
  assert.throws(() => scrubFixture(recorded(), { ...options, forbid: ["Item"] }), /left "Item"/);
  assert.throws(() => scrubFixture(recorded(), { ...options, forbid: [/example-org/] }), /forbidden pattern #1/);
  assert.throws(() => scrubFixture({ nodes: "no" }), /not a recorded board/);
  assert.throws(() => scrubFixture({ nodes: [{ content: { title: "x" } }] }), /no issue numbers/);
});
