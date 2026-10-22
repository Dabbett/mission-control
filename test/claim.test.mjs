import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertWriteOnly, assertReadOnly, rootFields, definitions } from "../src/readonly.mjs";
import { claimPlan, createClaimer, CLAIM_FIELDS, UNCLAIM_FIELDS } from "../src/claim.mjs";
import { normalize } from "../src/model.mjs";
import { root, exampleProjects, claimableBoard } from "./helpers.mjs";

const W = "mu" + "tation";
const CLAIM = readFileSync(join(root, "src", "claim.graphql"), "utf8");
const UNCLAIM = readFileSync(join(root, "src", "unclaim.graphql"), "utf8");
const example = exampleProjects({ start: { enabled: true, claim: "dashboard" }, localPath: root }).get("example");

// ── the documents and their guard ───────────────────────────────────────────

test("each claim document is one write whose root fields are exactly its list", () => {
  assert.deepEqual(assertWriteOnly(CLAIM, CLAIM_FIELDS), CLAIM_FIELDS);
  assert.deepEqual(assertWriteOnly(UNCLAIM, UNCLAIM_FIELDS), UNCLAIM_FIELDS);
  assert.throws(() => assertReadOnly(CLAIM), /not a query/, "and neither passes as the board's read");
  assert.deepEqual(definitions(CLAIM).map((d) => d.kind), ["write"]);
});

test("the write guard refuses a query, two operations, fragments, an alias and a field off the list", () => {
  assert.throws(() => assertWriteOnly("query Q { a }", ["a"]), /not a write/);
  assert.throws(() => assertWriteOnly(`${W} A { a } ${W} B { a }`, ["a"]), /exactly one operation/);
  assert.throws(() => assertWriteOnly(`${W} A { a { ...F } } fragment F on T { b }`, ["a"]), /must not use fragments/);
  assert.throws(() => assertWriteOnly(`${W} A { addAssigneesToAssignable: deleteIssue(input: {}) { x } }`, CLAIM_FIELDS), /alias/);
  assert.throws(() => assertWriteOnly(`${W} A { addAssigneesToAssignable(input: {}) { x } deleteIssue(input: { id: "x" }) { y } }`, CLAIM_FIELDS), /outside its list: deleteIssue/);
  assert.throws(() => assertWriteOnly(`${W} A { }`, ["a"]), /no root field/);
});

test("rootFields skips arguments (braces included), directives and nested selections", () => {
  assert.deepEqual(rootFields(" a(input: { b: { c: $x } }) @include(if: $y) { d { e } } f { g } "), ["a", "f"]);
  assert.deepEqual(rootFields(" a(x: [1, 2]) , b "), ["a", "b"]);
});

test("a comment cannot smuggle a root field past the guard", () => {
  assert.deepEqual(assertWriteOnly(`${W} A { a # deleteIssue(input: {}) { x }\n }`, ["a"]), ["a"]);
});

// ── the plan ────────────────────────────────────────────────────────────────

test("claimPlan: assigns the viewer, sets the first inProgress name, and undoes only what it changes", () => {
  const n = normalize(claimableBoard(), example);
  const p = claimPlan(n, example, 6);
  assert.deepEqual(p.ctx, { issueId: "I_6", viewerId: "U_me", projectId: "PVT_1", itemId: "PVTI_6", fieldId: "F_status", optionId: "O_prog" });
  assert.deepEqual(p.undo, { removeAssignee: true, restoreStatus: true, clearStatus: false, previousOptionId: "O_todo" });
  assert.equal(p.status, "In progress");

  n.items.set(6, { ...n.items.get(6), assignees: ["me"], status: null });
  assert.deepEqual(claimPlan(n, example, 6).undo, { removeAssignee: false, restoreStatus: false, clearStatus: true, previousOptionId: "" }, "already mine, and no Status before");
});

test("claimPlan: says why it cannot claim, instead of guessing", () => {
  const n = normalize(claimableBoard(), example);
  assert.match(claimPlan({ ...n, viewer: null }, example, 6).error, /who the token belongs to/);
  assert.match(claimPlan({ ...n, statusField: null }, example, 6).error, /no single-select Status field/);
  assert.match(claimPlan({ ...n, statusField: { id: "F", options: [{ id: "O", name: "Todo" }] } }, example, 6).error, /no option "In progress"/);
  n.items.set(6, { ...n.items.get(6), nodeId: null });
  assert.match(claimPlan(n, example, 6).error, /without the ids/);
  assert.match(claimPlan(n, example, 999).error, /not on the board/);
});

// ── the sender ──────────────────────────────────────────────────────────────

function recorder(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    const r = typeof reply === "function" ? reply(calls.length) : reply;
    return { ok: (r.status ?? 200) === 200, status: r.status ?? 200, json: async () => r.json };
  };
  return { calls, claimer: createClaimer({ fetch, getToken: async () => "tok" }) };
}

const CTX = { issueId: "I_6", viewerId: "U_me", projectId: "PVT_1", itemId: "PVTI_6", fieldId: "F_status", optionId: "O_prog" };
const OK = { json: { data: { addAssigneesToAssignable: { assignable: { assignees: { nodes: [{ login: "me" }] } } }, updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_6" } } } } };

test("claim sends the committed claim document with the plan's variables, and nothing else", async () => {
  const { calls, claimer } = recorder(OK);
  const r = await claimer.claim(CTX);
  assert.deepEqual(r, { ok: true, assigned: true, statusSet: true, assignees: ["me"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["query", "variables"]);
  assert.equal(calls[0].body.query, CLAIM);
  assert.deepEqual(calls[0].body.variables, CTX);
  assert.equal(calls[0].auth, "Bearer tok");
});

test("claim reports which half landed, and turns a missing write permission into an instruction", async () => {
  const half = { json: { data: { addAssigneesToAssignable: { assignable: { assignees: { nodes: [{ login: "me" }] } } }, updateProjectV2ItemFieldValue: null }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }] } };
  const r = await recorder(half).claimer.claim(CTX);
  assert.equal(r.ok, false);
  assert.equal(r.assigned, true);
  assert.equal(r.statusSet, false);
  assert.match(r.error, /read-only MISSION_CONTROL_TOKEN cannot claim.*gh auth refresh -s project/);
  assert.match((await recorder({ status: 502, json: {} }).claimer.claim(CTX)).error, /HTTP 502/);
  assert.match((await recorder({ status: 401, json: {} }).claimer.claim(CTX)).error, /401/);
});

test("unclaim sends the undo document with only the landed parts switched on, and skips the call when nothing landed", async () => {
  const undo = { removeAssignee: true, restoreStatus: true, clearStatus: false, previousOptionId: "O_todo" };
  const { calls, claimer } = recorder({ json: { data: {} } });
  assert.deepEqual(await claimer.unclaim(CTX, undo), { ok: true });
  assert.equal(calls[0].body.query, UNCLAIM);
  assert.deepEqual(calls[0].body.variables, { ...CTX, optionId: "O_todo", removeAssignee: true, restoreStatus: true, clearStatus: false });
  await claimer.unclaim(CTX, undo, { assigned: true, statusSet: false });
  assert.deepEqual([calls[1].body.variables.removeAssignee, calls[1].body.variables.restoreStatus], [true, false]);
  assert.deepEqual(await claimer.unclaim(CTX, { ...undo, removeAssignee: false }, { assigned: true, statusSet: false }), { ok: true, nothing: true });
  assert.equal(calls.length, 2, "nothing to undo, nothing sent");
});
