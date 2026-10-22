// Mission control page. Everything is built with createElement and textContent. Links are
// set only through github() and the board link, both of which accept GitHub URLs only.

const NONCE = document.querySelector('meta[name="mc-nonce"]')?.content ?? "";
const RUN_ID = document.querySelector('meta[name="mc-run"]')?.content ?? "";
const params = new URLSearchParams(location.search);
let projectKey = params.get("project");
let board = null;
let timer = null;
let selected = null; // { kind: "part" | "decisions" | "unsorted", path }
const staged = []; // issue numbers on the Workbench, in the order staged; kept until the page reloads
const startErrors = new Map(); // issue number -> why its last Start was refused; shown on its staged card
let restarted = false; // the server restarted since this page loaded, so the page's nonce is dead
let failure = null; // { kind: "unreachable" | "noData", msg } from the last load, or null
let receivedAt = 0; // Date.now() when `board` arrived, so its age keeps counting while the server is silent
let shownNotice = null; // the notice text on screen; redrawn only when it changes, so the alert is not re-announced
const DRAG_TYPE = "application/x-mc-issue";
const MANY_STARTED = 2; // at this many issues started in one server run, or more, the Workbench warns

const GLYPH = { done: "✓", inProgress: "◐", inReview: "◑", ready: "▶", blocked: "■", decision: "◇", dropped: "⊘", notStarted: "○", allDropped: "⊘" };
const LABEL = { done: "Done", inProgress: "In progress", inReview: "In review", ready: "Ready", blocked: "Blocked", decision: "Open decision", dropped: "Dropped", notStarted: "Not started", allDropped: "All dropped" };

// ── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/** The link helper. Links only to GitHub, in a new tab, with no referrer. */
function github(text, url) {
  const a = el("a", { target: "_blank", rel: "noopener noreferrer", text });
  if (typeof url === "string" && url.startsWith("https://github.com/")) a.setAttribute("href", url);
  return a;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function chip(text, cls = "", withDot = false) {
  // Blocked and Decision differ by hue alone otherwise, so a decision chip always carries its glyph.
  const label = cls === "decision" && text && !text.startsWith(GLYPH.decision) ? `${GLYPH.decision} ${text}` : text;
  return el("span", { class: `chip ${cls}`.trim() }, withDot ? el("span", { class: "dot" }) : null, label);
}

function prChip(pr) {
  const result = pr.checks;
  const cls = result === "SUCCESS" ? "ok" : result === "FAILURE" || result === "ERROR" ? "warn" : result ? "pending" : "muted";
  const label = `PR #${pr.number}${pr.isDraft ? " draft" : ""}${pr.state !== "OPEN" ? " " + pr.state.toLowerCase() : ""}${result ? " · " + result.toLowerCase() : ""}`;
  const c = chip("", cls);
  c.append(github(label, pr.url));
  return c;
}

// ── rings ───────────────────────────────────────────────────────────────────

function ring(counts, state) {
  const r = 18;
  const circ = 2 * Math.PI * r;
  const none = counts.total === 0;
  const s = svg("svg", { class: `ring${none ? " none" : ""}`, viewBox: "0 0 44 44", role: "img" });
  const title = svg("title");
  title.textContent = none ? LABEL[state] : `${counts.done} of ${counts.total} done`;
  s.append(title);
  s.append(svg("circle", { class: "track", cx: 22, cy: 22, r }));
  if (!none) {
    const filled = (counts.done / counts.total) * circ;
    s.append(svg("circle", { class: "fill", cx: 22, cy: 22, r, "stroke-dasharray": `${filled.toFixed(2)} ${circ.toFixed(2)}` }));
  }
  const t = svg("text", { class: `pct${none ? " small" : ""}`, x: 22, y: 22 });
  t.textContent = none ? "–" : `${counts.percent}%`;
  s.append(t);
  return s;
}

// ── HUD ─────────────────────────────────────────────────────────────────────

function renderHud(b) {
  document.getElementById("hud-project").textContent = b.project.title;
  const link = document.getElementById("hud-board");
  if (b.board?.url && b.board.url.startsWith("https://github.com/")) {
    link.setAttribute("href", b.board.url);
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  const hero = document.getElementById("hud-hero");
  clear(hero);
  const t = b.boardTotals ?? { done: 0, total: 0, ready: 0, blocked: 0, inProgress: 0, percent: null };
  hero.append(
    el("div", {}, el("span", { class: "hero-figure", text: t.percent === null ? "–" : `${t.percent}%` }), " ", el("span", { class: "hero-label", text: `complete · ${t.done} of ${t.total} on the board` })),
    el("div", { class: "chip-row" }, chip(`${t.ready} ready`, "ready", true), chip(`${t.inProgress} in progress`, "inProgress", true), chip(`${t.blocked} blocked`, "blocked", true), chip(`${b.decisions?.open?.length ?? 0} open decisions`, "decision")),
  );
  const meta = document.getElementById("hud-meta");
  clear(meta);
  meta.append(el("span", { id: "hud-age", text: ageText(b) }));
  if (b.rateLimit) meta.append(el("span", { text: `rate limit ${b.rateLimit.remaining} left · cost ${b.rateLimit.cost}` }));
  // Staleness is said in the notice, not here, so the HUD keeps its height.
  if (b.backoff?.active) meta.append(el("span", { class: "badge backoff", text: `backing off until ${new Date(b.backoff.until).toLocaleTimeString()}` }));
  if (b.refused === "too-soon") toast("Refreshed less than 15 s ago; serving the cache");
  if (b.refused === "too-soon-after-failure") toast("The last fetch failed less than 15 s ago; showing the cached board");
  if (b.refused === "backoff") toast("Rate-limit backoff: forced refresh refused");
}

/** The board's age now, counted on this side too, so a silent server cannot leave "just now" on screen. */
function ageSeconds(b) {
  return b.ageSeconds === null ? null : b.ageSeconds + Math.round((Date.now() - receivedAt) / 1000);
}

function ageText(b) {
  const age = ageSeconds(b);
  const when = age === null ? "no data" : age < 5 ? "just now" : age < 120 ? `${age}s ago` : `${Math.round(age / 60)} min ago`;
  return `fetched ${when} · every ${b.refreshSeconds}s`;
}

/** Start is off while the page cannot trust what it shows: an old board, a silent server, or a dead nonce. */
function startBlocked() {
  if (restarted) return "Mission control restarted; reload the page to Start.";
  if (failure?.kind === "unreachable") return "The server is not answering; Start is off until it does.";
  if (failure) return "The server has no board data; Start is off until it does.";
  if (board?.stale) return "The board is stale; Start is off until a fetch succeeds.";
  return null;
}

// ── bands ───────────────────────────────────────────────────────────────────

function card(part, path) {
  const c = el("button", {
    type: "button",
    class: `card s-${part.state}${part.counts.ready > 0 ? " glow" : ""}${selected?.path === path ? " selected" : ""}`,
    onclick: () => openPart(part, path),
  });
  c.append(ring(part.counts, part.state));
  const body = el("div", {});
  body.append(el("div", { class: "name", text: part.name }));
  body.append(el("div", { class: "state" }, el("span", { class: "glyph", "aria-hidden": "true", text: GLYPH[part.state] }), LABEL[part.state], part.counts.total ? ` · ${part.counts.done}/${part.counts.total}` : ""));
  const meta = el("div", { class: "meta" });
  if (part.counts.ready) meta.append(chip(`${part.counts.ready} ready`, "ready", true));
  if (part.counts.blocked) meta.append(chip(`${part.counts.blocked} blocked`, "blocked", true));
  if (part.counts.dropped) meta.append(chip(`${part.counts.dropped} dropped`, "muted"));
  for (const pr of part.openPRs) meta.append(prChip(pr));
  if (part.decisions.length) meta.append(chip(`${part.decisions.length} decision${part.decisions.length > 1 ? "s" : ""}`, "decision"));
  if (meta.childNodes.length) body.append(meta);
  c.append(body);
  return c;
}

function bandHead(title, sub) {
  return el("div", { class: "band-head" }, el("h2", { text: title }), sub ? el("span", { class: "sub", text: sub }) : null);
}

function renderBands(b) {
  const app = document.getElementById("app");
  clear(app);
  app.classList.toggle("stale", Boolean(startBlocked()));

  if (b.drift?.length || b.truncated?.length || b.partial?.length) {
    const strip = el("div", { class: "chip-row" });
    const partial = b.partial ?? [];
    if (partial.length) {
      const c = chip(`GitHub could not read ${partial.length} item${partial.length > 1 ? "s" : ""} of the board; they are missing or fail closed`, "warn");
      c.setAttribute("title", partial.join("\n"));
      strip.append(c);
    }
    for (const d of b.drift ?? []) {
      const text =
        d.kind === "missing" ? `config names #${d.number} (${d.part}) but it is not on the board`
        : d.kind === "unclaimed" ? `#${d.number}, a child of epic #${d.epic}, is claimed by no part`
        : d.kind === "unknownStatus" ? `Status "${d.name}" on ${d.count} item${d.count > 1 ? "s" : ""} is in none of the config's status lists: they show as Ready, but Start refuses them until the config names it`
        : `epic #${d.number} is not on the board`;
      strip.append(chip(`config drift: ${text}`, "warn"));
    }
    for (const t of b.truncated ?? []) strip.append(chip(`#${t.number}: ${t.fields.join(", ")} truncated`, "warn"));
    app.append(strip);
  }

  for (const layer of b.layers) {
    const groups = el("div", { class: "groups" });
    for (const g of layer.groups) {
      const box = el("div", { class: `group${g.phone ? " phone" : ""}` });
      if (g.name || layer.groups.length > 1) {
        const head = el("h3", {}, g.name || " ");
        if (g.counts.total) head.append(el("span", { class: "sub", text: `${g.counts.done}/${g.counts.total} done${g.counts.dropped ? `, ${g.counts.dropped} dropped` : ""}` }));
        if (g.epic) head.append(el("span", { class: "sub", text: `epic #${g.epic}` }));
        box.append(head);
      }
      const cards = el("div", { class: "cards" });
      for (const p of g.parts) cards.append(card(p, p.path));
      box.append(cards);
      groups.append(box);
    }
    const total = layer.groups.reduce((n, g) => n + g.counts.total, 0);
    const done = layer.groups.reduce((n, g) => n + g.counts.done, 0);
    const dropped = layer.groups.reduce((n, g) => n + g.counts.dropped, 0);
    app.append(el("section", { class: "band" }, bandHead(layer.name, total ? `${done}/${total} done${dropped ? `, ${dropped} dropped` : ""}` : "nothing filed"), groups));
  }

  app.append(decisionsBand(b));
  app.append(unsortedBand(b));
}

function decisionRow(d, closed = false) {
  const tags = el("div", { class: "tags" });
  for (const x of d.external) tags.append(chip(x, "decision"));
  if (d.blocks.length) tags.append(chip(`blocks ${d.blocks.map((n) => "#" + n).join(", ")}`, "warn"));
  if (d.assignees.length) tags.append(chip(d.assignees.join(", "), "muted"));
  if (d.state === "blocked") tags.append(chip(d.reason, "warn"));
  return el("div", { class: `row decision${closed ? " closed" : ""}` }, el("span", { class: "num", text: `#${d.number}` }), el("span", { class: "title" }, github(d.title, d.url)), tags);
}

function decisionsBand(b) {
  const list = el("div", { class: "list" });
  for (const d of b.decisions.open) list.append(decisionRow(d));
  if (!b.decisions.open.length) list.append(el("p", { class: "empty", text: "No open decisions." }));
  const closed = el("div", { class: "list", hidden: true });
  for (const d of b.decisions.closed) closed.append(decisionRow(d, true));
  const toggle = el("button", { type: "button", class: "toggle", text: `show ${b.decisions.closed.length} answered`, onclick: () => (closed.hidden = !closed.hidden) });
  return el("section", { class: "band" }, bandHead("Decisions", `${b.decisions.open.length} open, answered by people, never by agents`), list, b.decisions.closed.length ? toggle : null, closed);
}

function leafRow(l) {
  const tags = el("div", { class: "tags" });
  tags.append(chip(`${GLYPH[l.state]} ${LABEL[l.state]}`, l.state === "ready" ? "ready" : l.state === "blocked" ? "warn" : "muted"));
  for (const pr of l.prs.filter((p) => p.state === "OPEN")) tags.append(prChip(pr));
  return el("div", { class: `row${l.state === "done" || l.state === "dropped" ? " closed" : ""}` }, el("span", { class: "num", text: `#${l.number}` }), el("span", { class: "title" }, github(l.title, l.url)), tags);
}

function unsortedBand(b) {
  const u = b.unsorted;
  const list = el("div", { class: "list" });
  for (const l of u.open) list.append(leafRow(l));
  for (const pr of u.prs) list.append(el("div", { class: "row closed" }, el("span", { class: "num", text: `PR #${pr.number}` }), el("span", { class: "title" }, github(pr.title, pr.url)), el("div", { class: "tags" }, chip(pr.state.toLowerCase(), "muted"))));
  for (const d of u.drafts) list.append(el("div", { class: "row" }, el("span", { class: "num", text: "draft" }), el("span", { class: "title", text: d.title }), el("div", { class: "tags" })));
  if (!list.childNodes.length) list.append(el("p", { class: "empty", text: "Nothing unsorted. Every open item belongs to a part." }));
  const closed = el("div", { class: "list", hidden: true });
  for (const l of u.closed) closed.append(leafRow(l));
  const toggle = el("button", { type: "button", class: "toggle", text: `show ${u.closed.length} closed`, onclick: () => (closed.hidden = !closed.hidden) });
  return el("section", { class: "band" }, bandHead("Unsorted", "on the board but under no part: file it under an epic, or add it to the config"), list, u.closed.length ? toggle : null, closed);
}

// ── drill-in panel ──────────────────────────────────────────────────────────

const ORDER = ["ready", "inReview", "inProgress", "blocked", "decision", "done", "dropped"];

function leafDetail(l, b) {
  const box = el("div", { class: `leaf s-${l.state}` });
  const line = el("div", { class: "line" }, el("span", { class: "num", text: `#${l.number}` }), el("span", { class: "title" }, github(l.title, l.url)));
  if (l.status) line.append(chip(l.statusKnown === false ? `${l.status} (not in the config)` : l.status, l.statusKnown === false ? "warn" : "muted"));
  if (l.assignees.length) line.append(chip(l.assignees.join(", "), "muted"));
  for (const x of l.external) line.append(chip(x, "decision"));
  box.append(line);
  if (l.reason) {
    const reason = el("div", { class: "reason", text: `${GLYPH[l.state]} ${LABEL[l.state]}: ${l.reason}` });
    if (l.blockers.length) {
      reason.append(" ");
      for (const bl of l.blockers) reason.append(github(`#${bl.number} ${bl.title}`, bl.url), " ");
    }
    box.append(reason);
  } else {
    box.append(el("div", { class: "sub", text: `${GLYPH[l.state]} ${LABEL[l.state]}` }));
  }
  if (l.prs.length) {
    const prs = el("div", { class: "line" });
    for (const pr of l.prs) prs.append(prChip(pr));
    box.append(prs);
  }
  if (l.truncated.length) box.append(el("div", { class: "sub", text: `truncated: ${l.truncated.join(", ")}` }));
  if (l.state === "ready") {
    // Shown on every Ready leaf: Ready only means the board has no blocking edge, which says nothing about prose.
    box.append(el("div", { class: "note", text: "No blocking edges on the board. Check the issue for dependencies written in prose before starting." }));
    if (l.commandError) box.append(el("div", { class: "reason", text: `No command: ${l.commandError}. Fix the label on GitHub.` }));
    if (l.copy) {
      // Only a Ready leaf with a command can go on the Workbench, by drag or by the button.
      box.classList.add("stageable");
      box.setAttribute("draggable", "true");
      box.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData(DRAG_TYPE, String(l.number));
        e.dataTransfer.effectAllowed = "copy";
      });
      const actions = el("div", { class: "actions" });
      actions.append(el("button", { type: "button", class: "btn btn-primary", text: "Copy prompt", onclick: () => copyLine(l.copy) }));
      actions.append(el("button", { type: "button", class: "btn", text: staged.includes(l.number) ? "On the Workbench" : "Add to Workbench", disabled: staged.includes(l.number), onclick: () => stage(l.number) }));
      if (l.model) actions.append(chip(`model ${l.model}${l.modelSource === "label" ? " (label)" : ""}`, "muted"));
      box.append(actions);
      box.append(el("pre", { class: "cmd", text: l.copy }));
    }
  } else {
    box.setAttribute("title", notStageable(l));
  }
  return box;
}

/** Why a leaf can't go on the Workbench. Only Blocked and Decision get the "change the board" hint. */
function notStageable(l) {
  if (l.state === "blocked" || l.state === "decision") return `${LABEL[l.state]}, so it can't go on the Workbench. If it shouldn't be, change the board.`;
  return `Already ${LABEL[l.state].toLowerCase()}, so there is nothing to start.`;
}

// ── workbench ───────────────────────────────────────────────────────────────

function partLeaves(b) {
  return b.layers.flatMap((layer) => layer.groups.flatMap((g) => g.parts.flatMap((p) => p.leaves)));
}

function findLeaf(b, number) {
  return partLeaves(b).find((l) => l.number === number) ?? null;
}

function stage(number) {
  if (!board) return;
  const l = findLeaf(board, number);
  if (!l) return toast(`#${number} is not under any part, so it can't go on the Workbench`);
  if (l.state !== "ready") return toast(`#${number}: ${notStageable(l)}${l.reason ? ` (${l.reason})` : ""}`);
  if (!l.copy) return toast(`#${number} has no command${l.commandError ? `: ${l.commandError}` : ""}`);
  if (!staged.includes(number)) staged.push(number);
  renderWorkbench(board);
  if (selected?.kind === "part") reopenSelected(board);
}

function unstage(number) {
  startErrors.delete(number);
  const i = staged.indexOf(number);
  if (i >= 0) staged.splice(i, 1);
  if (board) {
    renderWorkbench(board);
    if (selected?.kind === "part") reopenSelected(board);
  }
}

function stagedCard(number, b) {
  const l = findLeaf(b, number);
  const box = el("div", { class: `staged s-${l?.state ?? "dropped"}` });
  box.append(el("div", { class: "line" }, el("span", { class: "num", text: `#${number}` }), el("span", { class: "title" }, l ? github(l.title, l.url) : "no longer on the board")));
  // The board can change while a card waits here. Start re-checks on the server too; this says so early.
  const ready = l && l.state === "ready" && l.copy;
  const unlisted = ready && l.statusKnown === false; // shown as Ready, but the server refuses to Start it
  if (!ready) {
    const why = !l ? "It left the board or its part." : l.state !== "ready" ? `Now ${LABEL[l.state]}${l.reason ? `: ${l.reason}` : ""}.` : `No command: ${l.commandError}.`;
    box.append(el("div", { class: "reason", text: `${why} It can't start until the board says Ready again.` }));
  } else {
    box.append(el("div", { class: "note", text: "No blocking edges on the board. Check the issue for dependencies written in prose before starting." }));
    if (l.assignees.length) box.append(el("div", { class: "reason", text: `Assigned to ${l.assignees.join(", ")}: someone may already be on it.` }));
  }
  // A refused Start stays on its card until the next Start or remove, not only in a toast that fades.
  if (startErrors.has(number)) box.append(el("div", { class: "reason start-error", text: `Last Start refused: ${startErrors.get(number)}` }));
  const actions = el("div", { class: "actions" });
  if (ready && l.model) actions.append(chip(`model ${l.model}${l.modelSource === "label" ? " (label)" : ""}`, "muted"));
  if (unlisted) box.append(el("div", { class: "reason", text: `Its Status "${l.status}" is in none of the config's status lists, so Start is off for it. Add the Status to the config, or copy the prompt.` }));
  if (ready && b.start?.enabled && !unlisted) {
    // The label names every reason a confirm is needed, from board data, and a click confirms exactly
    // those reasons. One the page hasn't seen yet comes back as a 409; the reload then adds it here.
    const startedAt = b.start.started?.[number];
    const reasons = [];
    if (startedAt) reasons.push(`Started ${new Date(startedAt).toLocaleTimeString()}`);
    if (l.assignees.length) reasons.push(`Assigned to ${l.assignees.join(", ")}`);
    const confirm = { started: Boolean(startedAt), assigned: l.assignees.length > 0 };
    const label = reasons.length ? `${reasons.join(" · ")} · start anyway?` : `Start #${number}`;
    const blocked = startBlocked();
    actions.append(el("button", { type: "button", class: `btn ${reasons.length ? "btn-warn" : "btn-primary"}`, text: label, disabled: Boolean(blocked), title: blocked, onclick: (e) => startIssue(number, e.currentTarget, confirm) }));
  } else if (ready) {
    actions.append(el("button", { type: "button", class: "btn btn-primary", text: "Copy prompt", onclick: () => copyLine(l.copy) }));
  }
  actions.append(el("button", { type: "button", class: "btn btn-ghost", text: "remove", onclick: () => unstage(number) }));
  box.append(actions);
  return box;
}

function renderWorkbench(b) {
  const wb = document.getElementById("workbench");
  const head = el("div", { class: "wb-head" }, el("h2", { text: "Workbench" }));
  if (!b.start?.enabled) head.append(el("span", { class: "sub", text: "Start is off: copy the prompt instead (start.enabled in the project config)" }));
  const startedCount = Object.keys(b.start?.started ?? {}).length;
  if (startedCount >= MANY_STARTED) head.append(chip(`${startedCount} sessions started this run; each one is a full Claude session`, "warn"));
  const body = el("div", { class: "wb-body" });
  for (const n of staged) body.append(stagedCard(n, b));
  if (!staged.length) body.append(el("p", { class: "empty", text: "Drag a Ready issue here, or use Add to Workbench. Blocked issues and decisions stay on the board." }));
  clear(wb);
  wb.append(head, body);
}

function reopenSelected(b) {
  const part = b.layers.flatMap((l) => l.groups.flatMap((g) => g.parts)).find((p) => p.path === selected.path);
  if (part) openPart(part, part.path);
}

function wireWorkbench() {
  const wb = document.getElementById("workbench");
  // Only our own drag type is accepted; text or links dragged in from elsewhere are ignored.
  wb.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    wb.classList.add("drop");
  });
  wb.addEventListener("dragleave", (e) => {
    if (!wb.contains(e.relatedTarget)) wb.classList.remove("drop");
  });
  wb.addEventListener("drop", (e) => {
    wb.classList.remove("drop");
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    const number = Number(e.dataTransfer.getData(DRAG_TYPE));
    if (Number.isSafeInteger(number) && number > 0) stage(number);
  });
}

function openPart(part, path) {
  if (!board) return; // between a project switch and its first load
  selected = { kind: "part", path };
  renderBands(board);
  const panel = document.getElementById("panel");
  document.getElementById("panel-title").textContent = `${part.name} · ${LABEL[part.state]}`;
  const body = document.getElementById("panel-body");
  clear(body);
  const kv = el("dl", { class: "kv" });
  kv.append(el("dt", { text: "where" }), el("dd", { text: part.path }));
  kv.append(el("dt", { text: "progress" }), el("dd", { text: part.counts.total ? `${part.counts.done} of ${part.counts.total} done (${part.counts.percent}%)${part.counts.dropped ? `, ${part.counts.dropped} dropped` : ""}` : "nothing filed yet" }));
  body.append(kv);
  if (part.decisions.length) {
    body.append(el("h3", { text: "Decisions it waits on" }));
    for (const d of part.decisions) body.append(leafDetail(d, board));
  }
  for (const state of ORDER) {
    const leaves = part.leaves.filter((l) => l.state === state);
    if (!leaves.length) continue;
    body.append(el("h3", { text: `${LABEL[state]} · ${leaves.length}` }));
    for (const l of leaves) body.append(leafDetail(l, board));
  }
  if (!part.leaves.length && !part.decisions.length) body.append(el("p", { class: "empty", text: "No issues mapped. File the work on the board, then add the numbers to the config." }));
  panel.hidden = false;
}

function closePanel() {
  selected = null;
  document.getElementById("panel").hidden = true;
  if (board) renderBands(board);
}

// ── actions ─────────────────────────────────────────────────────────────────

async function copyLine(line) {
  try {
    await navigator.clipboard.writeText(line);
    toast("Copied. Paste it into a terminal.");
  } catch {
    toast("Clipboard refused; select the command text and copy it by hand.");
  }
}

async function startIssue(number, button, confirm = {}) {
  button.disabled = true;
  startErrors.delete(number); // a new press replaces the old refusal, whatever this one ends in
  const asked = projectKey;
  try {
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mc-nonce": NONCE },
      body: JSON.stringify({ project: asked, number, confirm }),
    });
    const data = await res.json().catch(() => ({}));
    if (asked !== projectKey) return toast(`#${number} (${asked}): ${res.ok ? "started" : data.error ?? res.status}`, 6000); // switched meanwhile
    if (res.ok) {
      unstage(number);
      toast(`Started #${number}${data.model ? ` on ${data.model}` : ""} in a new Ghostty window`, 6000);
      await load(false);
    } else if (res.status === 409 && data.requiresConfirm) {
      // A reason the card didn't show. Nothing is remembered as confirmed: the reload puts it on the label.
      toast(`Not started: #${number} changed since the card was drawn. Check its label, then press Start again.`, 6000);
      await load(false);
    } else {
      if (res.status === 403 && data.runId && data.runId !== RUN_ID) restarted = true;
      startErrors.set(number, data.error ?? `HTTP ${res.status}`);
      toast(`Start refused: ${data.error ?? res.status}`, 6000);
      // A 409 means the board moved (no longer Ready, a bad label, a missing checkout): redraw the card from fresh data.
      if (res.status === 409 || restarted) await load(false);
      else if (board) renderWorkbench(board);
    }
  } catch (e) {
    startErrors.set(number, e.message);
    toast(`Start failed: ${e.message}`, 6000);
    if (board) renderWorkbench(board);
  } finally {
    button.disabled = false;
  }
}

// ── load loop ───────────────────────────────────────────────────────────────

/** One notice for whatever the page cannot trust right now, most serious first. It is an alert region, so it holds
 *  no ticking numbers: the board's age lives in the HUD. */
function renderNotice() {
  const n = document.getElementById("notice");
  let msg = null;
  if (restarted) msg = "Mission control restarted since this page loaded, so Start needs a fresh page. Reloading empties the Workbench.";
  else if (failure?.kind === "unreachable") msg = `The local server is not answering (${failure.msg}). Is mission control still running? It is tried again every ${board?.refreshSeconds ?? 60} s.`;
  else if (failure) msg = `No board data: ${failure.msg}`;
  else if (board?.stale) msg = `GitHub could not be read (${board.error}), so this is the last board read; its age is at the top right. Start is off until a fetch succeeds.`;
  if (msg === shownNotice) return;
  shownNotice = msg;
  clear(n);
  n.hidden = !msg;
  if (!msg) return;
  n.append(el("span", { text: msg }));
  if (restarted) n.append(el("button", { type: "button", class: "btn", text: "Reload", onclick: () => location.reload() }));
}

/** With no board at all, the main area says what is wrong instead of "Reading the board…" under an error. */
function renderEmpty(msg) {
  const app = document.getElementById("app");
  clear(app);
  app.append(el("div", { class: "empty-state" }, el("h2", { text: "No board to show" }), el("p", { text: msg }), el("p", { class: "sub", text: "Press refresh (r) to try now." })));
}

/** Record a failed load: keep whatever board is on screen, but mark it untrustworthy and keep polling. */
function loadFailed(kind, msg) {
  failure = { kind, msg };
  renderNotice();
  if (board) {
    renderBands(board);
    renderWorkbench(board);
    if (selected?.kind === "part") reopenSelected(board);
  } else {
    renderEmpty(msg);
  }
  schedule(board?.refreshSeconds ?? 60);
}

async function load(force = false) {
  const q = new URLSearchParams();
  if (projectKey) q.set("project", projectKey);
  if (force) q.set("force", "1");
  const asked = projectKey;
  let res;
  try {
    res = await fetch(`/api/board?${q}`);
  } catch (e) {
    if (asked !== projectKey) return; // the project was switched while this was in flight
    loadFailed("unreachable", e.message); // keeps polling; the server may come back
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (asked !== projectKey) return; // the project was switched while this was in flight; its own load follows
  if (data.runId && RUN_ID && data.runId !== RUN_ID) restarted = true;
  if (!res.ok) {
    document.getElementById("hud-project").textContent = data.project?.title ?? projectKey ?? "";
    loadFailed("noData", String(data.error ?? res.status));
    return;
  }
  failure = null;
  board = data;
  receivedAt = Date.now();
  renderNotice();
  projectKey = data.project.key;
  document.title = `${data.project.title} · Mission control`;
  renderHud(data);
  renderBands(data);
  renderWorkbench(data);
  if (selected?.kind === "part") reopenSelected(data);
  schedule(data.refreshSeconds);
}

function schedule(seconds) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (document.hidden) return;
    load(false);
  }, Math.max(15, seconds) * 1000);
}

async function initProjects() {
  try {
    const list = await (await fetch("/api/projects")).json();
    if (!projectKey && list.length) projectKey = list[0].key;
    if (list.length > 1) {
      const sel = document.getElementById("hud-switch");
      for (const p of list) sel.append(el("option", { value: p.key, text: p.title }));
      sel.value = projectKey;
      sel.hidden = false;
      sel.addEventListener("change", () => {
        projectKey = sel.value;
        history.replaceState(null, "", `?project=${encodeURIComponent(projectKey)}`);
        // Issue numbers are per repo: a staged #130 must not reappear as another project's #130.
        staged.length = 0;
        startErrors.clear();
        board = null;
        failure = null;
        clear(document.getElementById("workbench"));
        // The old project's bands and totals must not sit under the new project's name while it loads.
        clear(document.getElementById("hud-hero"));
        clear(document.getElementById("hud-meta"));
        const app = document.getElementById("app");
        clear(app);
        app.classList.remove("stale");
        app.append(el("p", { class: "boot", text: "Reading the board…" }));
        renderNotice();
        closePanel();
        load(true);
      });
    }
  } catch {}
}

document.getElementById("refresh").addEventListener("click", () => load(true));
wireWorkbench();
document.getElementById("panel-close").addEventListener("click", closePanel);
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea")) return;
  if (e.key === "Escape") closePanel();
  if (e.key === "r" && !e.metaKey && !e.ctrlKey) load(true);
});
setInterval(() => {
  const age = document.getElementById("hud-age");
  if (age && board) age.textContent = ageText(board);
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load(false); // also recovers a page whose first load failed while hidden
});

await initProjects();
load(false);
