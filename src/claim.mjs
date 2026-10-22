// The opt-in claim at Start (start.claim "dashboard"; ADR 0002). The only module that sends a write to GitHub, and
// it sends exactly two committed documents: the claim and its undo. Everything else stays read-only (github.mjs).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertWriteOnly } from "./readonly.mjs";
import { normStatus, claimStatusName } from "./status.mjs";
import { getToken as defaultGetToken, forgetToken } from "./token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const CLAIM_FIELDS = ["addAssigneesToAssignable", "updateProjectV2ItemFieldValue"];
export const UNCLAIM_FIELDS = ["removeAssigneesFromAssignable", "updateProjectV2ItemFieldValue", "clearProjectV2ItemFieldValue"];
const CLAIM = readFileSync(join(here, "claim.graphql"), "utf8");
const UNCLAIM = readFileSync(join(here, "unclaim.graphql"), "utf8");
assertWriteOnly(CLAIM, CLAIM_FIELDS);
assertWriteOnly(UNCLAIM, UNCLAIM_FIELDS);

const ENDPOINT = "https://api.github.com/graphql";
const TIMEOUT_MS = 15_000;

/**
 * What the claim writes for one issue, and what its undo restores. Pure: reads the refetched board only.
 * Returns { ctx, undo } or { error } with a reason the card can show.
 */
export function claimPlan(normalized, project, number) {
  const item = normalized.items.get(number);
  if (!item) return { error: `#${number} is not on the board` };
  const viewer = normalized.viewer;
  if (!viewer?.id) return { error: "GitHub did not say who the token belongs to, so there is no one to assign" };
  const field = normalized.statusField;
  if (!normalized.projectId || !field?.id) return { error: "the board has no single-select Status field to set" };
  if (!item.nodeId || !item.itemId) return { error: `#${number} came back without the ids a claim needs` };
  const target = claimStatusName(project);
  const option = field.options.find((o) => normStatus(o.name) === normStatus(target));
  if (!option) return { error: `the board's Status field has no option "${target}" (the first name in status.inProgress)` };
  const previous = item.status ? field.options.find((o) => normStatus(o.name) === normStatus(item.status)) : null;
  // The undo must be able to put the old Status back; a name the field no longer offers would leave it In progress.
  if (item.status && !previous) return { error: `its Status "${item.status}" is not an option of the board's Status field, so a failed launch could not put it back` };
  return {
    ctx: { issueId: item.nodeId, viewerId: viewer.id, projectId: normalized.projectId, itemId: item.itemId, fieldId: field.id, optionId: option.id },
    undo: {
      // Only what the claim changed: an assignee that was already there stays, and so does the old Status.
      // A truncated list may hide the viewer, so an undo never removes an assignee it cannot prove it added.
      removeAssignee: !item.assignees.includes(viewer.login) && !item.truncated.includes("assignees"),
      restoreStatus: Boolean(previous && previous.id !== option.id),
      clearStatus: !item.status,
      previousOptionId: previous?.id ?? "",
    },
    viewer: viewer.login,
    status: option.name,
    before: item.assignees,
  };
}

/** A GitHub message turned into one the user can act on. Messages never carry the token. */
function explain(messages) {
  const text = messages.join("; ");
  if (/not accessible|insufficient|scope|permission|forbidden/i.test(text)) {
    return `${text}. The token cannot write here: a read-only MISSION_CONTROL_TOKEN cannot claim, and gh needs the project scope (gh auth refresh -s project)`;
  }
  return text;
}

/**
 * @param {{ fetch?: typeof fetch, getToken?: () => Promise<string> }} [deps]   test seams only
 */
export function createClaimer(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const getToken = deps.getToken ?? defaultGetToken;

  /** Never rejects: every failure comes back as errors, with `unknown` when GitHub's answer never arrived. */
  async function send(query, variables) {
    let token;
    try {
      token = await getToken();
    } catch (e) {
      return { data: null, errors: [e instanceof Error ? e.message : String(e)], unknown: false }; // nothing was sent
    }
    let res;
    let json;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "user-agent": "mission-control" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401) {
        forgetToken();
        return { data: null, errors: ["GitHub rejected the token (401). Run `gh auth login` again."] };
      }
      // A 5xx may come after GitHub applied the write (a gateway lost the answer); a 4xx is a refusal.
      if (!res.ok) return { data: null, errors: [`GitHub returned HTTP ${res.status}`], unknown: res.status >= 500 };
      json = await res.json();
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") return { data: null, errors: [`GitHub did not answer within ${TIMEOUT_MS / 1000} s`], unknown: true };
      if (e?.name === "SyntaxError") return { data: null, errors: ["GitHub returned a body that is not JSON"], unknown: true };
      return { data: null, errors: [`GitHub unreachable: ${e?.message ?? e}`], unknown: true };
    }
    const errors = Array.isArray(json?.errors) ? json.errors.map((e) => e?.message ?? "unknown error") : [];
    return { data: json?.data ?? null, errors };
  }

  /** Assign the viewer and set the Status. Says which half landed, so a partial claim can be undone exactly. */
  async function claim(ctx) {
    const { data, errors, unknown } = await send(CLAIM, ctx);
    const assigned = Boolean(data?.addAssigneesToAssignable);
    const statusSet = Boolean(data?.updateProjectV2ItemFieldValue);
    const nodes = data?.addAssigneesToAssignable?.assignable?.assignees?.nodes;
    const assignees = Array.isArray(nodes) ? nodes.map((n) => n?.login).filter((l) => typeof l === "string") : null;
    if (errors.length || !assigned || !statusSet) return { ok: false, assigned, statusSet, assignees, unknown: Boolean(unknown), error: explain(errors.length ? errors : ["GitHub did not confirm the claim"]) };
    return { ok: true, assigned, statusSet, assignees };
  }

  /** Undo the parts of a claim that landed. `landed` limits it further after a partial claim. */
  async function unclaim(ctx, undo, landed = { assigned: true, statusSet: true }) {
    const variables = {
      ...ctx,
      optionId: undo.previousOptionId,
      removeAssignee: Boolean(landed.assigned && undo.removeAssignee),
      restoreStatus: Boolean(landed.statusSet && undo.restoreStatus),
      clearStatus: Boolean(landed.statusSet && undo.clearStatus),
    };
    if (!variables.removeAssignee && !variables.restoreStatus && !variables.clearStatus) return { ok: true, nothing: true };
    const { errors } = await send(UNCLAIM, variables);
    return errors.length ? { ok: false, error: explain(errors) } : { ok: true };
  }

  return { claim, unclaim };
}
