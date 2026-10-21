// Loads and validates project files (<config dir>/*.json). The config is the only home for the layout.
// The config dir is the user's (~/.config/mission-control/projects/) when it holds a file, so a user's
// board, paths and prompt never sit inside this repo; the repo's projects/ ships only example.json.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function expandHome(p, home = homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.-]*$/;

function fail(source, msg) {
  throw new Error(`${source}: ${msg}`);
}

function stringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isPositiveInt(n) {
  return Number.isSafeInteger(n) && n > 0;
}

/** Validate one raw project object and return the normalized project. */
export function validateProject(raw, source = "project") {
  if (!raw || typeof raw !== "object") fail(source, "not an object");
  const p = {};

  if (typeof raw.key !== "string" || !KEY_RE.test(raw.key)) fail(source, "key must be lowercase letters, digits and dashes");
  p.key = raw.key;
  p.title = typeof raw.title === "string" && raw.title ? raw.title : raw.key;

  if (typeof raw.org !== "string" || !raw.org) fail(source, "org is required");
  p.org = raw.org;
  if (!isPositiveInt(raw.projectNumber)) fail(source, "projectNumber must be a positive integer");
  p.projectNumber = raw.projectNumber;
  if (typeof raw.repo !== "string" || !REPO_RE.test(raw.repo)) fail(source, "repo must be owner/name");
  p.repo = raw.repo;

  if (typeof raw.localPath !== "string" || !raw.localPath) fail(source, "localPath is required");
  p.localPath = resolve(expandHome(raw.localPath));
  if (!isAbsolute(p.localPath)) fail(source, "localPath must resolve to an absolute path");

  p.refreshSeconds = raw.refreshSeconds ?? 60;
  if (!isPositiveInt(p.refreshSeconds) || p.refreshSeconds < 15) fail(source, "refreshSeconds must be an integer of at least 15");

  const st = raw.status;
  if (!st || typeof st !== "object") fail(source, "status mapping is required");
  for (const k of ["done", "inReview", "inProgress", "todo"]) {
    if (!stringArray(st[k])) fail(source, `status.${k} must be an array of option names`);
  }
  p.status = { done: st.done, inReview: st.inReview, inProgress: st.inProgress, todo: st.todo };

  p.decisionType = raw.decisionType ?? "Decision";
  if (typeof p.decisionType !== "string") fail(source, "decisionType must be a string");
  p.epicLabel = raw.epicLabel ?? "epic";
  if (typeof p.epicLabel !== "string") fail(source, "epicLabel must be a string");
  const pat = raw.onHoldPattern ?? "^\\[On hold\\]";
  if (typeof pat !== "string") fail(source, "onHoldPattern must be a string");
  try {
    p.onHoldPattern = new RegExp(pat, "i");
  } catch {
    fail(source, "onHoldPattern is not a valid regular expression");
  }

  if (typeof raw.prompt !== "string" || !raw.prompt) fail(source, "prompt template is required");
  p.prompt = raw.prompt;
  if (!stringArray(raw.command) || raw.command.length === 0) fail(source, "command must be a non-empty array of strings");
  p.command = raw.command;

  const start = raw.start ?? {};
  if (typeof start !== "object") fail(source, "start must be an object");
  p.start = { enabled: start.enabled === true, terminal: start.terminal ?? "ghostty" };
  if (p.start.terminal !== "ghostty") fail(source, `start.terminal "${p.start.terminal}" is not supported`);
  if (p.start.enabled && p.command[0] !== "claude") fail(source, 'start.enabled needs command[0] to be "claude"; the launcher runs nothing else');

  // Optional model choice: a default plus a per-issue label override, both limited to an allowlist.
  // The value lands in argv after "--model", so it must look like a model name, never like a flag.
  p.model = null;
  if (raw.model !== undefined) {
    const m = raw.model;
    if (!m || typeof m !== "object") fail(source, "model must be an object");
    if (p.command[0] !== "claude") fail(source, 'model needs command[0] to be "claude"');
    if (p.command.some((a) => a === "--model" || a.startsWith("--model="))) fail(source, "model and a --model in command conflict; keep one");
    if (!stringArray(m.allowed) || m.allowed.length === 0) fail(source, "model.allowed must be a non-empty array of model names");
    for (const name of m.allowed) if (!MODEL_RE.test(name)) fail(source, `model.allowed: "${name}" is not a model name`);
    const def = m.default ?? null;
    if (def !== null && !m.allowed.includes(def)) fail(source, `model.default "${def}" is not in model.allowed`);
    const prefix = m.labelPrefix ?? "model:";
    if (typeof prefix !== "string" || !prefix) fail(source, "model.labelPrefix must be a non-empty string");
    p.model = { default: def, allowed: [...m.allowed], labelPrefix: prefix };
  }

  if (!Array.isArray(raw.layers)) fail(source, "layers must be an array");
  const epics = new Set();
  p.layers = raw.layers.map((layer, li) => {
    if (typeof layer?.name !== "string" || !layer.name) fail(source, `layers[${li}].name is required`);
    if (!Array.isArray(layer.groups)) fail(source, `layers[${li}].groups must be an array`);
    const groups = layer.groups.map((g, gi) => {
      const where = `layers[${li}].groups[${gi}]`;
      if (!g || typeof g !== "object") fail(source, `${where} must be an object`);
      const group = { name: typeof g.name === "string" ? g.name : "", epic: null, phone: g.phone === true, parts: [] };
      if (g.epic !== undefined) {
        if (!isPositiveInt(g.epic)) fail(source, `${where}.epic must be a positive integer`);
        group.epic = g.epic;
        epics.add(g.epic);
      }
      if (!Array.isArray(g.parts)) fail(source, `${where}.parts must be an array`);
      group.parts = g.parts.map((part, pi) => {
        if (typeof part?.name !== "string" || !part.name) fail(source, `${where}.parts[${pi}].name is required`);
        const issues = part.issues ?? [];
        if (!Array.isArray(issues) || !issues.every(isPositiveInt)) fail(source, `${where}.parts[${pi}].issues must be positive integers`);
        return { name: part.name, issues: [...new Set(issues)] };
      });
      return group;
    });
    return { name: layer.name, groups };
  });
  p.epics = [...epics];
  return p;
}

/** Load every *.json file in the config dir into a Map keyed by project key, in file-name order. */
export function loadProjects(dir) {
  const map = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const path = join(dir, file);
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      fail(file, `not valid JSON (${e.message})`);
    }
    const project = validateProject(raw, file);
    if (map.has(project.key)) fail(file, `duplicate project key "${project.key}"`);
    map.set(project.key, project);
  }
  if (map.size === 0) fail(dir, "no project files found; copy projects/example.json here and edit it");
  return map;
}

function hasProjectFiles(dir) {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
    throw new Error(`cannot read ${dir}: ${e.message}`); // a permissions error must not silently serve the example
  }
}

/**
 * Where project files live. An explicit dir (--config-dir or MC_CONFIG_DIR) wins and must exist. Otherwise the
 * user's dir, ${XDG_CONFIG_HOME:-~/.config}/mission-control/projects/, when it holds a .json file; otherwise the
 * repo's projects/ (the shipped example). `userDir` is always reported so a caller can say where to put a config.
 */
export function resolveConfigDir({ explicit = null, env = process.env, home = homedir(), root }) {
  const base = env.XDG_CONFIG_HOME ? resolve(expandHome(env.XDG_CONFIG_HOME, home)) : join(home, ".config");
  const userDir = join(base, "mission-control", "projects");
  if (explicit) {
    const dir = resolve(expandHome(explicit, home));
    if (!existsSync(dir)) throw new Error(`config dir ${dir} does not exist`);
    return { dir, source: "explicit", userDir };
  }
  if (hasProjectFiles(userDir)) return { dir: userDir, source: "user", userDir };
  return { dir: join(root, "projects"), source: "repo", userDir };
}

/** The project to open: the requested key (which must exist), else the only one, else the first by file order. */
export function pickProject(projects, requested = null) {
  if (requested) {
    if (!projects.has(requested)) throw new Error(`no project "${requested}". Available: ${[...projects.keys()].join(", ")}`);
    return requested;
  }
  return [...projects.keys()][0];
}
