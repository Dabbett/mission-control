// Opt-in Start: opens a new Ghostty window running the launcher, which runs claude. No shell anywhere.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { argvFor, modelFor } from "./prompt.mjs";
import { issueView, LEAF } from "./model.mjs";
import { claimPlan, createClaimer } from "./claim.mjs";

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
 * @param {(argv: string[], opts: { env: object }) => Promise<void>} [deps.launch]   test seam; default runs `open` with the argv and the allowlisted env
 * @param {() => number} [deps.now]
 * @param {string} [deps.node]   absolute node binary for the launcher
 * @param {{ claim: Function, unclaim: Function }} [deps.claimer]   test seam; default writes to GitHub (claim.mjs)
 */
export function createStarter(deps) {
  if (!deps?.root || !isAbsolute(deps.root)) throw new Error("createStarter needs an absolute root");
  const launcher = join(deps.root, "bin", "launch.mjs");
  const launch = deps.launch ?? defaultLaunch;
  const now = deps.now ?? (() => Date.now());
  const node = deps.node ?? process.execPath;
  const claimer = deps.claimer ?? createClaimer();
  const started = new Map(); // "<key>#<number>" -> ISO time, kept until the server restarts
  const locks = new Set();

  function ghosttyArgv(project, issue) {
    const argv = ["-na", "Ghostty.app", "--args", "--quit-after-last-window-closed=true", "-e", node, launcher, "--cwd", project.localPath, "--", ...argvFor(project, issue)];
    for (const a of argv) if (/[\r\n]/.test(a)) throw new Error("argument contains a line break");
    return argv;
  }

  function startedFor(key) {
    const out = {};
    for (const [id, at] of started) if (id.startsWith(`${key}#`)) out[id.slice(key.length + 1)] = at;
    return out;
  }

  /** confirm is per reason, { started, assigned }: agreeing to one never passes the other. */
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
    const prev = started.get(id);
    // The prompt tells agents to claim the issue; an assignee means someone (or another session) may already have.
    // Every unconfirmed reason comes back at once, so a page that showed none learns all of them in one refusal.
    const missing = [];
    if (prev && confirm?.started !== true) missing.push(["started", `started at ${prev}`]);
    if (view.assignees.length && confirm?.assigned !== true) missing.push(["assigned", `assigned to ${view.assignees.join(", ")}`]);
    if (missing.length) {
      const error = `#${number} was ${missing.map(([, text]) => text).join(" and is ")}`;
      return { status: 409, body: { error, requiresConfirm: missing.map(([reason]) => reason), ...(prev ? { startedAt: prev } : {}), assignees: view.assignees } };
    }
    locks.add(id);
    try {
      let argv;
      try {
        argv = ghosttyArgv(project, view);
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
      try {
        await launch(argv, { env: childEnv() });
      } catch (e) {
        const undo = plan ? await claimer.unclaim(plan.ctx, plan.undo) : null;
        return { status: 500, body: { error: `launch failed: ${e instanceof Error ? e.message : String(e)}${undo ? `.${undoNote(undo, true)}` : ""}` } };
      }
      const at = new Date(now()).toISOString();
      started.set(id, at);
      return { status: 200, body: { ok: true, startedAt: at, model, command: argvFor(project, view), ...(plan ? { claimed: { by: plan.viewer, status: plan.status } } : {}) } };
    } finally {
      locks.delete(id);
    }
  }

  return { start, startedFor, ghosttyArgv, launcher };
}

/** One sentence on how an undo went, for the refusal. A failed undo says what to fix by hand. */
function undoNote(undo, always = false) {
  if (!undo) return "";
  if (!undo.ok) return ` Undoing the claim failed too (${undo.error}): check the assignee and Status on GitHub and change them back by hand.`;
  return always || !undo.nothing ? " Your part of the claim was undone." : "";
}
