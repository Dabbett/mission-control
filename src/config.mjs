// Loads and validates project files (<config dir>/*.json). The config is the only home for the layout.
// The config dir is the user's (~/.config/mission-control/projects/) when it holds a file, so a user's
// board, paths and prompt never sit inside this repo; the repo's projects/ ships only example.json.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DANGEROUS_FLAGS } from "./claude-flags.mjs";
import { normStatus, STATUS_GROUPS } from "./status.mjs";
import { partPath } from "./model.mjs";

export { normStatus, STATUS_GROUPS };

export function expandHome(p, home = homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.-]*$/;
const KNOWN_KEYS = ["key", "title", "org", "projectNumber", "repo", "localPath", "refreshSeconds", "status", "decisionType", "epicLabel", "onHoldPattern", "prompt", "command", "start", "model", "layers"];
const START_KEYS = ["enabled", "terminal", "claim"];
const MODEL_KEYS = ["default", "allowed", "labelPrefix"];
const LAYER_KEYS = ["name", "groups"];
const GROUP_KEYS = ["name", "epic", "phone", "parts"];
const PART_KEYS = ["name", "issues"];
// Shapes of the tokens people are most likely to paste: Anthropic keys, GitHub tokens and fine-grained PATs.
const SECRET_RE = /\b(sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/;
const LINE_BREAK = /[\r\n]/;

function fail(source, msg) {
  throw new Error(`${source}: ${msg}`);
}

/** The path of the first string value that looks like a token, or null. The value itself is never reported. */
function findSecret(value, path = "") {
  if (typeof value === "string") return SECRET_RE.test(value) ? path || "(root)" : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecret(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const hit = findSecret(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}

/** Refuse keys outside `known` at `where`, so a typo such as start.enable fails instead of quietly meaning false. */
function checkKeys(obj, known, where, source) {
  const unknown = Object.keys(obj).filter((k) => !known.includes(k));
  if (unknown.length) fail(source, `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `${where}.${k}`).join(", ")}; known keys there: ${known.join(", ")}`);
}

function duplicate(names) {
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return null;
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
  // Typos and pasted secrets are refused, not ignored: an unknown key would silently fall back to a default, and a
  // token in this file would be committed with it.
  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length) fail(source, `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; known keys: ${KNOWN_KEYS.join(", ")}`);
  const secretAt = findSecret(raw);
  if (secretAt) fail(source, `the value at ${secretAt} looks like a token; secrets never go in project files (the server uses your gh login)`);
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
  if (LINE_BREAK.test(raw.localPath)) fail(source, "localPath must not contain a line break");
  p.localPath = resolve(expandHome(raw.localPath));
  if (!isAbsolute(p.localPath)) fail(source, "localPath must resolve to an absolute path");

  p.refreshSeconds = raw.refreshSeconds ?? 60;
  if (!isPositiveInt(p.refreshSeconds) || p.refreshSeconds < 15) fail(source, "refreshSeconds must be an integer of at least 15");

  const st = raw.status;
  if (!st || typeof st !== "object") fail(source, "status mapping is required");
  checkKeys(st, STATUS_GROUPS, "status", source);
  for (const k of STATUS_GROUPS) {
    if (!stringArray(st[k])) fail(source, `status.${k} must be an array of option names`);
  }
  p.status = { done: st.done, inReview: st.inReview, inProgress: st.inProgress, todo: st.todo };
  // A name in two lists would be decided by rule order; say so instead.
  const seenStatus = new Map();
  for (const k of STATUS_GROUPS) {
    for (const name of st[k]) {
      const n = normStatus(name);
      if (!n) fail(source, `status.${k} has an empty option name`);
      if (seenStatus.has(n) && seenStatus.get(n) !== k) fail(source, `Status "${name}" is in both status.${seenStatus.get(n)} and status.${k}`);
      seenStatus.set(n, k);
    }
  }

  p.decisionType = raw.decisionType ?? "Decision";
  if (typeof p.decisionType !== "string") fail(source, "decisionType must be a string");
  p.epicLabel = raw.epicLabel ?? "epic";
  if (typeof p.epicLabel !== "string") fail(source, "epicLabel must be a string");
  if (raw.onHoldPattern === null) {
    p.onHoldPattern = null; // the on-hold rule is off
  } else {
    const pat = raw.onHoldPattern ?? "^\\[On hold\\]";
    if (typeof pat !== "string") fail(source, "onHoldPattern must be a string, or null to turn the on-hold rule off");
    if (!pat) fail(source, "onHoldPattern is empty, which would match every title; set it to null to turn the on-hold rule off");
    try {
      p.onHoldPattern = new RegExp(pat, "i");
    } catch {
      fail(source, "onHoldPattern is not a valid regular expression");
    }
  }

  if (typeof raw.prompt !== "string" || !raw.prompt) fail(source, "prompt template is required");
  if (LINE_BREAK.test(raw.prompt)) fail(source, "prompt must not contain a line break; Start passes it as one argument");
  p.prompt = raw.prompt;
  if (!stringArray(raw.command) || raw.command.length === 0) fail(source, "command must be a non-empty array of strings");
  raw.command.forEach((part, i) => {
    if (LINE_BREAK.test(part)) fail(source, `command[${i}] must not contain a line break`);
    if (part.includes("{title}")) fail(source, `command[${i}] must not use {title}; it is a prompt placeholder, where it is wrapped as untrusted text`);
    if (part === "--session-id" || part.startsWith("--session-id=")) fail(source, `command[${i}] must not set --session-id; Start gives every session its own (ADR 0003)`);
  });
  if (!raw.command.some((part) => part.includes("{prompt}"))) fail(source, "command must include {prompt} in one element, or the agent starts with no first message");
  p.command = raw.command;

  const start = raw.start ?? {};
  if (!start || typeof start !== "object") fail(source, "start must be an object");
  checkKeys(start, START_KEYS, "start", source);
  p.start = { enabled: start.enabled === true, terminal: start.terminal ?? "ghostty", claim: start.claim ?? "agent" };
  if (p.start.terminal !== "ghostty") fail(source, `start.terminal "${p.start.terminal}" is not supported`);
  // "agent": the prompt asks the session to claim the issue (best-effort). "dashboard": Start claims it on GitHub
  // before launching (ADR 0002), the one write this tool makes.
  if (p.start.claim !== "agent" && p.start.claim !== "dashboard") fail(source, 'start.claim must be "agent" or "dashboard"');
  if (p.start.claim === "dashboard" && !p.start.enabled) fail(source, 'start.claim "dashboard" needs start.enabled: the claim happens at Start');
  if (p.start.claim === "dashboard" && !st.inProgress.length) fail(source, 'start.claim "dashboard" needs a name in status.inProgress: it is the Status the claim sets');
  if (p.start.enabled && p.command[0] !== "claude") fail(source, 'start.enabled needs command[0] to be "claude"; the launcher runs nothing else');
  if (p.start.enabled) {
    const flag = p.command.find((a) => DANGEROUS_FLAGS.test(a));
    if (flag) fail(source, `command carries ${flag}, which takes the human out of the session; Start refuses it (Copy still works with Start off)`);
  }

  // Optional model choice: a default plus a per-issue label override, both limited to an allowlist.
  // The value lands in argv after "--model", so it must look like a model name, never like a flag.
  p.model = null;
  if (raw.model !== undefined) {
    const m = raw.model;
    if (!m || typeof m !== "object") fail(source, "model must be an object");
    checkKeys(m, MODEL_KEYS, "model", source);
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
    if (!layer || typeof layer !== "object") fail(source, `layers[${li}] must be an object`);
    checkKeys(layer, LAYER_KEYS, `layers[${li}]`, source);
    if (typeof layer.name !== "string" || !layer.name) fail(source, `layers[${li}].name is required`);
    if (!Array.isArray(layer.groups)) fail(source, `layers[${li}].groups must be an array`);
    const groups = layer.groups.map((g, gi) => {
      const where = `layers[${li}].groups[${gi}]`;
      if (!g || typeof g !== "object") fail(source, `${where} must be an object`);
      checkKeys(g, GROUP_KEYS, where, source);
      const group = { name: typeof g.name === "string" ? g.name : "", epic: null, phone: g.phone === true, parts: [] };
      if (g.epic !== undefined) {
        if (!isPositiveInt(g.epic)) fail(source, `${where}.epic must be a positive integer`);
        group.epic = g.epic;
        epics.add(g.epic);
      }
      if (!Array.isArray(g.parts)) fail(source, `${where}.parts must be an array`);
      group.parts = g.parts.map((part, pi) => {
        if (!part || typeof part !== "object") fail(source, `${where}.parts[${pi}] must be an object`);
        checkKeys(part, PART_KEYS, `${where}.parts[${pi}]`, source);
        if (typeof part.name !== "string" || !part.name) fail(source, `${where}.parts[${pi}].name is required`);
        const issues = part.issues ?? [];
        if (!Array.isArray(issues) || !issues.every(isPositiveInt)) fail(source, `${where}.parts[${pi}].issues must be positive integers`);
        return { name: part.name, issues: [...new Set(issues)] };
      });
      return group;
    });
    return { name: layer.name, groups };
  });
  // Names are paths on the page (a part's drill-in reopens by path), so a duplicate would reopen the wrong one.
  const dupLayer = duplicate(p.layers.map((l) => l.name));
  if (dupLayer) fail(source, `two layers are named "${dupLayer}"`);
  for (const layer of p.layers) {
    const dupGroup = duplicate(layer.groups.map((g) => g.name).filter(Boolean));
    if (dupGroup) fail(source, `two groups in ${layer.name} are named "${dupGroup}"`);
    // Checked as whole paths across the layer, built as buildSkeleton builds them: two unnamed groups that each
    // hold a part "P" would both be "L / P".
    const dupPath = duplicate(layer.groups.flatMap((g) => g.parts.map((part) => partPath(layer.name, g.name, part.name))));
    if (dupPath) fail(source, `two parts have the path "${dupPath}"; rename one, or name their groups`);
  }
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
