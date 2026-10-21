#!/usr/bin/env node
// Turns a recorded board into a synthetic one for test/fixtures/.
// The shape survives: which items exist, their Status group, state and type, blocked-by edges, parent and
// sub-issue links, PR links and check results, how many assignees. Every word of board text goes: titles, labels,
// URLs, org, repo, logins, check names, custom Status and issue-type names. Timestamps are flattened and the
// numbers shift so they don't match the source board's. `forbid` lists strings or regular expressions that must
// not survive; the scrub throws instead of returning a fixture that still contains one.
// Usage: node scripts/scrub-fixture.mjs <recorded.json> <out.json>
//   The command line applies the defaults only (no Status or decision-type mapping from a project config), so a
//   board whose decision type is not literally "Decision" loses its decisions. Prefer
//   `npm run record-fixture -- --synthetic`, which passes the project's config and the publish denylist.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXAMPLE = Object.freeze({ key: "example", title: "Example", org: "example-org", repo: "example-org/example-app", projectNumber: 1 });
const RECORDED_AT = "2026-01-02T00:00:00.000Z";
const UPDATED_AT = "2026-01-01T12:00:00Z";
const EXTERNAL_NAMES = ["partner", "legal", "vendor", "client"];
// Status names per config group, and GitHub's default issue types: generic, so they may stay.
const STATUS_NAME = { done: "Done", inReview: "In review", inProgress: "In progress", todo: "Todo" };
const DEFAULT_ISSUE_TYPES = ["Task", "Bug", "Feature"];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function scrubFixture(fixture, { epicLabel = "epic", modelLabelPrefix = "model:", status = null, decisionType = "Decision", forbid = [] } = {}) {
  if (!fixture || typeof fixture !== "object" || !Array.isArray(fixture.nodes)) throw new Error("not a recorded board: expected { project, nodes }");
  const out = JSON.parse(JSON.stringify(fixture));

  const numbers = [];
  (function collect(o) {
    if (Array.isArray(o)) return o.forEach(collect);
    if (!o || typeof o !== "object") return;
    if (typeof o.number === "number") numbers.push(o.number);
    for (const k of Object.keys(o)) collect(o[k]);
  })(out.nodes);
  if (numbers.length === 0) throw new Error("no issue numbers in the fixture");
  const offset = Math.min(...numbers) - 1;
  const renumber = (n) => n - offset;

  const labels = new Map();
  let externals = 0;
  let others = 0;
  const relabel = (name) => {
    if (name === epicLabel || name.toLowerCase().startsWith(modelLabelPrefix.toLowerCase())) return name;
    if (!labels.has(name)) {
      const external = /^external:/i.test(name);
      labels.set(name, external ? `external: ${EXTERNAL_NAMES[externals] ?? `party-${externals + 1}`}` : `label-${others + 1}`);
      if (external) externals++;
      else others++;
    }
    return labels.get(name);
  };

  const logins = new Map();
  const relogin = (login) => {
    if (!logins.has(login)) logins.set(login, `user${logins.size + 1}`);
    return logins.get(login);
  };

  // A Status option named in the config maps to its group's generic name; anything else becomes "Status N".
  const statuses = new Map();
  for (const [group, names] of Object.entries(status ?? {})) for (const n of names ?? []) statuses.set(n, STATUS_NAME[group]);
  const restatus = (name) => {
    if (Object.values(STATUS_NAME).includes(name)) return name;
    if (!statuses.has(name)) statuses.set(name, `Status ${[...statuses.values()].filter((v) => v.startsWith("Status ")).length + 1}`);
    return statuses.get(name);
  };

  const types = new Map();
  const retype = (name) => {
    if (name === decisionType) return "Decision";
    if (DEFAULT_ISSUE_TYPES.includes(name)) return name;
    if (!types.has(name)) types.set(name, `Type ${types.size + 1}`);
    return types.get(name);
  };

  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (typeof o.number === "number") {
      const isPR = o.__typename === "PullRequest" || /\/pull\/\d+$/.test(o.url ?? "");
      const n = renumber(o.number);
      o.number = n;
      if (typeof o.title === "string") o.title = `${/^\[On hold\]/i.test(o.title) ? "[On hold] " : ""}${isPR ? "PR" : "Item"} ${n}`;
      if (typeof o.url === "string") o.url = `https://github.com/${EXAMPLE.repo}/${isPR ? "pull" : "issues"}/${n}`;
    }
    if (typeof o.updatedAt === "string") o.updatedAt = UPDATED_AT;
    if (typeof o.status?.name === "string") o.status.name = restatus(o.status.name);
    if (typeof o.issueType?.name === "string") o.issueType.name = retype(o.issueType.name);
    if (Array.isArray(o.labels?.nodes)) for (const l of o.labels.nodes) l.name = relabel(l.name);
    if (Array.isArray(o.assignees?.nodes)) o.assignees.nodes = o.assignees.nodes.map((a) => ({ login: relogin(a.login) }));
    if (Array.isArray(o.statusCheckRollup?.contexts?.nodes)) o.statusCheckRollup.contexts.nodes.forEach((c, i) => { c.name = `check-${i + 1}`; });
    delete o.id;
    for (const k of Object.keys(o)) walk(o[k]);
  })(out.nodes);

  out.recordedAt = RECORDED_AT;
  out.project = { key: EXAMPLE.key, org: EXAMPLE.org, projectNumber: EXAMPLE.projectNumber, title: EXAMPLE.title, url: `https://github.com/orgs/${EXAMPLE.org}/projects/${EXAMPLE.projectNumber}` };

  // The whole fixture is tested as one JSON string, so a pattern anchored with ^ or $ behaves differently here than
  // in the line-by-line scan of scripts/denylist.mjs. Today's patterns are unanchored words, where both agree.
  const text = JSON.stringify(out);
  forbid.forEach((f, k) => {
    if (f instanceof RegExp) {
      if (f.test(text)) throw new Error(`scrub left a match for forbidden pattern #${k + 1} in the fixture; refusing to write it`);
    } else if (typeof f === "string" && f && new RegExp(escapeRe(f), "i").test(text)) {
      throw new Error(`scrub left "${f}" in the fixture; refusing to write it`);
    }
  });
  return { fixture: out, offset };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error("usage: node scripts/scrub-fixture.mjs <recorded.json> <out.json>");
    process.exit(2);
  }
  const recorded = JSON.parse(readFileSync(input, "utf8"));
  const forbid = [recorded.project?.org, recorded.project?.title, recorded.project?.url].filter(Boolean);
  const { fixture, offset } = scrubFixture(recorded, { forbid });
  writeFileSync(output, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${fixture.nodes.length} items to ${output} (numbers shifted by -${offset})`);
}
