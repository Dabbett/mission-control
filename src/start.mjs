// Opt-in Start: opens a new Ghostty window running the launcher, which runs claude. No shell anywhere.
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { argvFor, modelFor } from "./prompt.mjs";
import { issueView, LEAF } from "./model.mjs";

function defaultLaunch(argv) {
  return new Promise((resolve, reject) => {
    execFile("open", argv, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * @param {object} deps
 * @param {string} deps.root   absolute path of this repo (for bin/launch.mjs)
 * @param {(argv: string[]) => Promise<void>} [deps.launch]   test seam; default runs `open` with the argv
 * @param {() => number} [deps.now]
 * @param {string} [deps.node]   absolute node binary for the launcher
 */
export function createStarter(deps) {
  if (!deps?.root || !isAbsolute(deps.root)) throw new Error("createStarter needs an absolute root");
  const launcher = join(deps.root, "bin", "launch.mjs");
  const launch = deps.launch ?? defaultLaunch;
  const now = deps.now ?? (() => Date.now());
  const node = deps.node ?? process.execPath;
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
    const { model, error: modelError } = modelFor(project, view);
    if (modelError) return { status: 409, body: { error: `#${number}: ${modelError}` } };
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
      const argv = ghosttyArgv(project, view);
      await launch(argv);
      const at = new Date(now()).toISOString();
      started.set(id, at);
      return { status: 200, body: { ok: true, startedAt: at, model, command: argvFor(project, view) } };
    } catch (e) {
      return { status: 500, body: { error: `launch failed: ${e instanceof Error ? e.message : String(e)}` } };
    } finally {
      locks.delete(id);
    }
  }

  return { start, startedFor, ghosttyArgv, launcher };
}
