// Pure functions: raw board nodes → items → leaf states → skeleton. No I/O, no clock.
import { normStatus, STATUS_GROUPS } from "./status.mjs";

export const LEAF = Object.freeze({
  dropped: "dropped",
  done: "done",
  blocked: "blocked",
  inReview: "inReview",
  inProgress: "inProgress",
  decision: "decision",
  ready: "ready",
});

export const PART = Object.freeze({
  notStarted: "notStarted",
  allDropped: "allDropped",
  done: "done",
  inProgress: "inProgress",
  ready: "ready",
  blocked: "blocked",
});

function connection(conn, name, truncated) {
  if (!conn) return [];
  const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
  if (typeof conn.totalCount === "number" && conn.totalCount > nodes.length) truncated.push(name);
  return nodes;
}

function pullRequest(node) {
  const rollup = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const contexts = rollup?.contexts?.nodes ?? [];
  return {
    number: node.number,
    title: node.title ?? "",
    url: typeof node.url === "string" ? node.url : null,
    state: node.state,
    isDraft: node.isDraft === true,
    checks: rollup?.state ?? null,
    checkRuns: contexts
      .filter(Boolean)
      .map((c) => ({ name: c.name ?? c.context ?? "", result: c.conclusion ?? c.status ?? c.state ?? null })),
  };
}

function mergePRs(...lists) {
  const seen = new Map();
  for (const list of lists) for (const pr of list) if (pr && !seen.has(pr.number)) seen.set(pr.number, pullRequest(pr));
  return [...seen.values()];
}

/** Raw fetchBoard result → { items: Map<number, Item>, prItems, drafts, ... } */
export function normalize(board, project) {
  const items = new Map();
  const prItems = [];
  const drafts = [];
  for (const node of board.nodes ?? []) {
    const c = node?.content;
    if (!c) continue;
    const status = node.status?.name ?? null;
    if (c.__typename === "Issue") {
      const truncated = [];
      const labels = connection(c.labels, "labels", truncated).map((l) => l.name);
      const assignees = connection(c.assignees, "assignees", truncated).map((a) => a.login);
      const subIssues = connection(c.subIssues, "subIssues", truncated).map((s) => s.number);
      const blockedBy = connection(c.blockedBy, "blockedBy", truncated).map((b) =>
        b && typeof b.number === "number"
          ? { number: b.number, title: b.title ?? "", state: b.state, url: typeof b.url === "string" ? b.url : null, type: b.issueType?.name ?? null }
          : null,
      );
      const linked = connection(node.linked?.pullRequests, "linkedPullRequests", truncated);
      const closedBy = connection(c.closedByPullRequestsReferences, "closedByPullRequests", truncated);
      items.set(c.number, {
        number: c.number,
        title: c.title ?? "",
        state: c.state,
        stateReason: c.stateReason ?? null,
        url: typeof c.url === "string" ? c.url : null,
        status,
        type: c.issueType?.name ?? null,
        labels,
        assignees,
        parent: c.parent?.number ?? null,
        subIssues,
        blockedBy,
        prs: mergePRs(linked, closedBy),
        truncated,
        isEpic: labels.includes(project.epicLabel),
      });
    } else if (c.__typename === "PullRequest") {
      prItems.push({ ...pullRequest(c), status });
    } else if (c.__typename === "DraftIssue") {
      drafts.push({ title: c.title ?? "", status });
    }
  }
  return { items, prItems, drafts, rateLimit: board.rateLimit ?? null, title: board.title ?? null, url: board.url ?? null, fetchedAt: board.fetchedAt ?? null };
}

function externalLabels(labels) {
  return labels.filter((l) => /^external:/i.test(l));
}

/**
 * Which config list a board Status belongs to: "done", "inReview", "inProgress", "todo", "unknown" for a name in
 * none of them, or null when the item has no Status. Names match after trimming and lower-casing.
 */
export function statusGroup(project, status) {
  const n = normStatus(status);
  if (!n) return null;
  for (const g of STATUS_GROUPS) if ((project.status[g] ?? []).some((name) => normStatus(name) === n)) return g;
  return "unknown";
}

function describeBlocker(b, items, project) {
  const onBoard = items.get(b.number);
  return {
    number: b.number,
    title: b.title,
    state: b.state,
    url: b.url,
    isDecision: b.type === project.decisionType,
    external: onBoard ? externalLabels(onBoard.labels) : [],
  };
}

/** Leaf state for one issue. First matching rule wins, in the order of the plan's table. */
export function leafState(item, items, project) {
  if (item.state === "CLOSED" && item.stateReason === "NOT_PLANNED") return { state: LEAF.dropped, reason: "closed as not planned", blockers: [] };
  const group = statusGroup(project, item.status);
  if (item.state === "CLOSED" || group === "done") return { state: LEAF.done, reason: null, blockers: [] };
  if (project.onHoldPattern && project.onHoldPattern.test(item.title)) return { state: LEAF.blocked, reason: "on hold", blockers: [] };

  const blockers = [];
  let unreadable = false;
  for (const b of item.blockedBy) {
    if (!b) unreadable = true;
    else if (b.state === "OPEN") blockers.push(describeBlocker(b, items, project));
  }
  const truncated = item.truncated.includes("blockedBy");
  if (blockers.length || unreadable || truncated) {
    const parts = blockers.map((b) => (b.isDecision ? `waiting on decision #${b.number}` : `blocked by #${b.number}`) + (b.external.length ? ` (${b.external.join(", ")})` : ""));
    if (unreadable) parts.push("a blocker could not be read");
    if (truncated) parts.push("blocker list truncated");
    return { state: LEAF.blocked, reason: parts.join("; "), blockers };
  }

  const openPRs = item.prs.filter((p) => p.state === "OPEN");
  if (group === "inReview" || openPRs.some((p) => !p.isDraft)) return { state: LEAF.inReview, reason: null, blockers: [] };
  if (group === "inProgress" || openPRs.length > 0) return { state: LEAF.inProgress, reason: null, blockers: [] };
  if (item.type === project.decisionType) return { state: LEAF.decision, reason: "open decision", blockers: [] };
  return { state: LEAF.ready, reason: null, blockers: [] };
}

function leafView(item, items, project) {
  const s = leafState(item, items, project);
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    status: item.status,
    statusKnown: statusGroup(project, item.status) !== "unknown", // false: the config lists no such Status, so the item fell through to Ready
    type: item.type,
    labels: item.labels,
    external: externalLabels(item.labels),
    assignees: item.assignees,
    parent: item.parent,
    prs: item.prs,
    truncated: item.truncated,
    state: s.state,
    reason: s.reason,
    blockers: s.blockers,
  };
}

function partState(leaves) {
  if (leaves.length === 0) return PART.notStarted;
  const live = leaves.filter((l) => l.state !== LEAF.dropped);
  if (live.length === 0) return PART.allDropped;
  if (live.every((l) => l.state === LEAF.done)) return PART.done;
  if (live.some((l) => l.state === LEAF.inProgress || l.state === LEAF.inReview)) return PART.inProgress;
  if (live.some((l) => l.state === LEAF.ready)) return PART.ready;
  return PART.blocked;
}

function count(leaves) {
  const c = { total: 0, done: 0, dropped: 0, ready: 0, blocked: 0, inProgress: 0 };
  for (const l of leaves) {
    if (l.state === LEAF.dropped) {
      c.dropped++;
      continue;
    }
    c.total++;
    if (l.state === LEAF.done) c.done++;
    else if (l.state === LEAF.ready) c.ready++;
    else if (l.state === LEAF.blocked) c.blocked++;
    else if (l.state === LEAF.inProgress || l.state === LEAF.inReview) c.inProgress++;
  }
  c.percent = c.total ? Math.round((c.done / c.total) * 100) : null;
  return c;
}

function uniqueByNumber(leaves) {
  const seen = new Map();
  for (const l of leaves) if (!seen.has(l.number)) seen.set(l.number, l);
  return [...seen.values()];
}

/** A part's path on the page: the drill-in reopens by it, and the validator refuses two parts with the same one. */
export function partPath(layer, group, part) {
  return `${layer} / ${group ? group + " / " : ""}${part}`;
}

/** Everything the page needs, computed from normalized data and the project config. */
export function buildSkeleton(normalized, project) {
  const { items } = normalized;
  const claimed = new Set();
  const drift = [];
  const views = new Map();
  const view = (item) => {
    if (!views.has(item.number)) views.set(item.number, leafView(item, items, project));
    return views.get(item.number);
  };

  const layers = project.layers.map((layer) => ({
    name: layer.name,
    groups: layer.groups.map((group) => {
      const parts = group.parts.map((part) => {
        const where = partPath(layer.name, group.name, part.name);
        const leaves = [];
        const decisions = [];
        for (const n of part.issues) {
          const item = items.get(n);
          if (!item) {
            drift.push({ kind: "missing", number: n, part: where });
            continue;
          }
          claimed.add(n);
          if (item.type === project.decisionType) {
            decisions.push(view(item));
          } else if (item.isEpic) {
            for (const childNumber of item.subIssues) {
              const child = items.get(childNumber);
              if (!child) continue;
              claimed.add(childNumber);
              if (child.type === project.decisionType) decisions.push(view(child));
              else if (!child.isEpic) leaves.push(view(child));
            }
          } else {
            leaves.push(view(item));
          }
        }
        const unique = uniqueByNumber(leaves);
        const counts = count(unique);
        const openPRs = uniqueByNumber(unique.flatMap((l) => l.prs.filter((p) => p.state === "OPEN")));
        return { name: part.name, path: where, state: partState(unique), counts, leaves: unique, decisions, openPRs };
      });
      const groupLeaves = uniqueByNumber(parts.flatMap((p) => p.leaves));
      return { name: group.name, epic: group.epic, parts, counts: count(groupLeaves) };
    }),
  }));

  const decisions = { open: [], closed: [] };
  const blocks = new Map();
  for (const item of items.values()) {
    for (const b of item.blockedBy) {
      if (!b) continue;
      if (!blocks.has(b.number)) blocks.set(b.number, []);
      blocks.get(b.number).push(item.number);
    }
  }
  for (const item of [...items.values()].sort((a, b) => a.number - b.number)) {
    if (item.type !== project.decisionType) continue;
    const v = { ...view(item), blocks: blocks.get(item.number) ?? [] };
    (item.state === "OPEN" ? decisions.open : decisions.closed).push(v);
  }

  const unsorted = { open: [], closed: [], prs: [], drafts: normalized.drafts };
  const referencedPRs = new Set([...items.values()].flatMap((i) => i.prs.map((p) => p.number)));
  for (const item of [...items.values()].sort((a, b) => a.number - b.number)) {
    if (claimed.has(item.number) || item.type === project.decisionType || item.isEpic) continue;
    (item.state === "OPEN" ? unsorted.open : unsorted.closed).push(view(item));
  }
  for (const pr of normalized.prItems) if (!referencedPRs.has(pr.number)) unsorted.prs.push(pr);

  for (const e of project.epics) {
    const epic = items.get(e);
    if (!epic) {
      drift.push({ kind: "missingEpic", number: e });
      continue;
    }
    for (const child of epic.subIssues) if (!claimed.has(child)) drift.push({ kind: "unclaimed", number: child, epic: e });
  }

  // A Status the config does not list is a config problem, not a Ready item: say so where drift is shown.
  const unknownStatus = new Map();
  // Counted only where it matters: an issue that is Ready because of it. A closed issue is Done whatever its Status,
  // and an epic is not a leaf.
  for (const item of items.values()) {
    if (item.isEpic || statusGroup(project, item.status) !== "unknown") continue;
    if (leafState(item, items, project).state !== LEAF.ready) continue;
    unknownStatus.set(item.status, (unknownStatus.get(item.status) ?? 0) + 1);
  }
  for (const [name, n] of unknownStatus) drift.push({ kind: "unknownStatus", name, count: n });

  const allLeaves = uniqueByNumber(layers.flatMap((l) => l.groups.flatMap((g) => g.parts.flatMap((p) => p.leaves))));
  const boardLeaves = [...items.values()].filter((i) => !i.isEpic && i.type !== project.decisionType).map(view);
  const truncated = [...items.values()].filter((i) => i.truncated.length).map((i) => ({ number: i.number, fields: i.truncated }));

  return {
    project: { key: project.key, title: project.title, repo: project.repo },
    board: { title: normalized.title, url: normalized.url },
    fetchedAt: normalized.fetchedAt,
    rateLimit: normalized.rateLimit,
    layers,
    decisions,
    unsorted,
    drift,
    totals: count(allLeaves),
    boardTotals: count(boardLeaves),
    truncated,
  };
}

/** The leaf view of one issue, or null when it is not on the board. Used by the Start check. */
export function issueView(normalized, project, number) {
  const item = normalized.items.get(number);
  return item ? leafView(item, normalized.items, project) : null;
}
