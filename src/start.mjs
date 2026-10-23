// Opt-in Start: opens a new Ghostty window running the launcher, which runs claude. No shell anywhere.
import { execFile } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { argvFor, modelFor } from "./prompt.mjs";
import { issueView, LEAF } from "./model.mjs";
import { claimPlan, createClaimer } from "./claim.mjs";
import { createRecord, isLive, launcherAlive, listSessions, lockIssue, planRecord } from "./sessions.mjs";

/**
 * The environment a started session gets. `open` hands its environment to the app it launches, and Ghostty passes
 * it on to the shell and to claude, so the server's own environment (a MISSION_CONTROL_TOKEN, any future key) would
 * otherwise land in every agent session. Only what a terminal needs to run is passed, by allowlist.
 */
export const CHILD_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"];
export function childEnv(env = process.env) {
  const out = {};
  for (const k of CHILD_ENV_KEYS) if (typeof env[k] === "string") out[k] = env[k];
  return out;
}

function defaultLaunch(argv, { env }) {
  return new Promise((resolve, reject) => {
    execFile("open", argv, { env, timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** `git status` of a leftover worktree: { dirty } or { error }. execFile, no shell. */
function defaultWorktreeStatus(path) {
  return new Promise((resolve) => {
    execFile("git", ["-C", path, "status", "--porcelain"], { timeout: 5000 }, (err, stdout) => {
      if (err) resolve({ error: "git could not read it" });
      else resolve({ dirty: stdout.trim().length > 0 });
    });
  });
}

/** The worktree `claude -w <name>` uses: <localPath>/.claude/worktrees/<name>. Null when the command names none. */
export function worktreePath(project, argv) {
  let name = null;
  argv.forEach((a, i) => {
    if ((a === "-w" || a === "--worktree") && argv[i + 1] && !argv[i + 1].startsWith("-")) name = argv[i + 1];
    else if (a.startsWith("--worktree=")) name = a.slice("--worktree=".length);
  });
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) return null;
  return join(project.localPath, ".claude", "worktrees", name);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {string} deps.root   absolute path of this repo (for bin/launch.mjs)
 * @param {string} deps.stateDir   absolute session record dir (sessions.mjs sessionsDir()); tests pass a temp dir
 * @param {(argv: string[], opts: { env: object }) => Promise<void>} [deps.launch]   test seam; default runs `open` with the argv and the allowlisted env
 * @param {() => number} [deps.now]
 * @param {string} [deps.node]   absolute node binary for the launcher
 * @param {{ claim: Function, unclaim: Function }} [deps.claimer]   test seam; default writes to GitHub (claim.mjs)
 * @param {(record) => Promise<boolean>} [deps.alive]   test seam; default checks the launcher's pid and command line
 * @param {(path: string) => Promise<{ dirty?: boolean, error?: string }>} [deps.worktreeStatus]   test seam; default runs git
 */
export function createStarter(deps) {
  if (!deps?.root || !isAbsolute(deps.root)) throw new Error("createStarter needs an absolute root");
  if (!deps.stateDir || !isAbsolute(deps.stateDir)) throw new Error("createStarter needs an absolute stateDir");
  const launcher = join(deps.root, "bin", "launch.mjs");
  const launch = deps.launch ?? defaultLaunch;
  const now = deps.now ?? (() => Date.now());
  const node = deps.node ?? process.execPath;
  const claimer = deps.claimer ?? createClaimer();
  const alive = deps.alive ?? launcherAlive;
  const worktreeStatus = deps.worktreeStatus ?? defaultWorktreeStatus;
  const dir = deps.stateDir;
  const locks = new Set();

  function ghosttyArgv(project, issue, recordPath) {
    const argv = ["-na", "Ghostty.app", "--args", "--quit-after-last-window-closed=true", "-e", node, launcher, "--cwd", project.localPath, "--record", recordPath, "--", ...argvFor(project, issue)];
    for (const a of argv) if (/[\r\n]/.test(a)) throw new Error("argument contains a line break");
    return argv;
  }

  /** The newest session per issue number, for the board, and how many run now. */
  async function sessionsFor(key) {
    const all = await listSessions(dir, key, { now: now(), alive });
    const byNumber = {};
    for (const { number, ...s } of all) byNumber[number] ??= s;
    return { byNumber, running: all.filter(isLive).length };
  }

  /** confirm is per reason, { started, assigned, worktree }: agreeing to one never passes another. */
  async function start(project, number, { normalized, confirm = {} }) {
    const view = issueView(normalized, project, number);
    if (!view) return { status: 404, body: { error: `#${number} is not on the board` } };
    if (view.state !== LEAF.ready) return { status: 409, body: { error: `#${number} is ${view.state}, not Ready`, state: view.state, reason: view.reason } };
    // Ready only because the config names no such Status: "Waiting" or "Needs info" would pass the gate otherwise.
    if (view.statusKnown === false) return { status: 409, body: { error: `#${number}: its Status "${view.status}" is in none of the config's status lists, so Start cannot tell whether it is ready. Add it to the config (status.todo if it is).`, reason: "status" } };
    const { model, error: modelError } = modelFor(project, view);
    if (modelError) return { status: 409, body: { error: `#${number}: ${modelError}` } };
    // `open` returns success as soon as Ghostty accepts the request, so a missing checkout would otherwise be a
    // 200 with the error inside a window nobody is looking at. Check it here and say so on the card.
    if (!isDirectory(project.localPath)) return { status: 409, body: { error: `#${number}: localPath does not exist: ${project.localPath}`, reason: "localPath" } };
    const id = `${project.key}#${number}`;
    if (locks.has(id)) return { status: 429, body: { error: `#${number} is already starting` } };
    // Held from the session check to the record write, here and across every server on this machine.
    const release = lockIssue(dir, project.key, number, now());
    if (!release) return { status: 429, body: { error: `#${number} is already starting (another mission control on this machine)` } };
    locks.add(id);
    try {
      const sessions = (await listSessions(dir, project.key, { now: now(), alive })).filter((s) => s.number === number);
      // A live session is refused outright, confirm or not: a second one would work in the same worktree.
      const live = sessions.find(isLive);
      if (live) {
        const what = live.state === "starting" ? `a session launched at ${live.launchedAt} that has not opened yet` : `a session running since ${live.startedAt}`;
        return { status: 409, body: { error: `#${number} has ${what} on this machine. Close its window first; a second session would share its worktree.`, reason: "running", session: live } };
      }
      const prev = sessions[0] ?? null;
      const wt = worktreePath(project, argvFor(project, view));
      const wtStatus = wt && isDirectory(wt) ? await worktreeStatus(wt) : null;
      // The prompt tells agents to claim the issue; an assignee means someone (or another session) may already have.
      // Every unconfirmed reason comes back at once, so a page that showed none learns all of them in one refusal.
      const missing = [];
      if (prev && confirm?.started !== true) missing.push(["started", `was started at ${prev.launchedAt}`]);
      if (view.assignees.length && confirm?.assigned !== true) missing.push(["assigned", `is assigned to ${view.assignees.join(", ")}`]);
      if (wtStatus && (wtStatus.dirty || wtStatus.error) && confirm?.worktree !== true) {
        missing.push(["worktree", wtStatus.error ? `has a worktree at ${wt} that ${wtStatus.error}` : `has uncommitted changes in its worktree ${wt}`]);
      }
      if (missing.length) {
        const error = `#${number} ${missing.map(([, text]) => text).join(" and ")}`;
        return { status: 409, body: { error, requiresConfirm: missing.map(([reason]) => reason), ...(prev ? { startedAt: prev.launchedAt, session: prev } : {}), assignees: view.assignees, ...(missing.some(([r]) => r === "worktree") ? { worktree: wt } : {}) } };
      }
      const rec = planRecord(dir, project.key, number);
      let argv;
      try {
        argv = ghosttyArgv(project, view, rec.path);
      } catch (e) {
        return { status: 500, body: { error: `launch failed: ${e instanceof Error ? e.message : String(e)}. Nothing was claimed or launched.` } };
      }
      // With start.claim "dashboard", the issue is claimed on GitHub before anything launches (ADR 0002): a Start
      // anywhere else then refetches In progress and is refused by the Ready check above.
      let plan = null;
      if (project.start.claim === "dashboard") {
        plan = claimPlan(normalized, project, number);
        if (plan.error) return { status: 409, body: { error: `#${number} cannot be claimed: ${plan.error}. Nothing was launched.`, reason: "claim" } };
        const c = await claimer.claim(plan.ctx);
        if (!c.ok) {
          // A lost answer (timeout, dropped connection, 5xx) says nothing about what GitHub did. Removing our own
          // assignee is always safe; putting the Status back is not, since a rival may have claimed it meanwhile.
          // A GitHub answer says exactly which half landed.
          const landed = c.unknown ? { assigned: true, statusSet: false } : c;
          const undo = landed.assigned || landed.statusSet ? await claimer.unclaim(plan.ctx, plan.undo, landed) : { ok: true };
          const maybe = c.unknown ? ` The claim may have landed before the answer was lost; if #${number} now shows ${plan.status} and nobody is working on it, set its Status back on GitHub.` : "";
          return { status: 502, body: { error: `could not claim #${number} on GitHub: ${c.error}.${maybe}${undoNote(undo)} Nothing was launched.`, reason: "claim", wrote: true } };
        }
        // Two claims in the same moment both succeed (assignees is a list). Whoever sees a stranger backs off, and
        // takes back only its own assignee: the Status stays In progress, because the stranger's session is running.
        // A reply without the list cannot show a stranger, so it is treated the same way.
        const others = c.assignees ? c.assignees.filter((l) => l !== plan.viewer && !plan.before.includes(l)) : null;
        if (!others || others.length) {
          const undo = await claimer.unclaim(plan.ctx, plan.undo, { assigned: true, statusSet: false });
          const who = others ? `was claimed by ${others.join(", ")} at the same moment` : "was claimed, but GitHub did not return its assignees, so a claim by someone else at the same moment cannot be ruled out";
          return { status: 409, body: { error: `#${number} ${who}.${undoNote(undo)} Its Status stays ${plan.status}, in case their session started; if nobody is working on it, set the Status back on GitHub. Nothing was launched.`, reason: "claim", wrote: true, assignees: c.assignees } };
        }
      }
      // Written before the launch, so a Start a moment later (here or in another instance) sees "starting".
      const at = new Date(now()).toISOString();
      try {
        createRecord(rec.path, { v: 1, key: project.key, number, sessionId: rec.sessionId, launchedAt: at, cwd: project.localPath });
      } catch (e) {
        const undo = plan ? await claimer.unclaim(plan.ctx, plan.undo) : null;
        return { status: 500, body: { error: `could not write the session record: ${e.code ?? "error"}${undo ? `.${undoNote(undo, true)}` : ""}. Nothing was launched.` } };
      }
      try {
        await launch(argv, { env: childEnv() });
      } catch (e) {
        rmSync(rec.path, { force: true });
        const undo = plan ? await claimer.unclaim(plan.ctx, plan.undo) : null;
        return { status: 500, body: { error: `launch failed: ${e instanceof Error ? e.message : String(e)}${undo ? `.${undoNote(undo, true)}` : ""}` } };
      }
      return { status: 200, body: { ok: true, startedAt: at, sessionId: rec.sessionId, model, command: argvFor(project, view), ...(plan ? { claimed: { by: plan.viewer, status: plan.status } } : {}) } };
    } finally {
      locks.delete(id);
      release();
    }
  }

  return { start, sessionsFor, ghosttyArgv, launcher };
}

/** One sentence on how an undo went, for the refusal. A failed undo says what to fix by hand. */
function undoNote(undo, always = false) {
  if (!undo) return "";
  if (!undo.ok) return ` Undoing the claim failed too (${undo.error}): check the assignee and Status on GitHub and change them back by hand.`;
  return always || !undo.nothing ? " Your part of the claim was undone." : "";
}
