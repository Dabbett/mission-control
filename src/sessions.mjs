// The session record (ADR 0003): one file per Start under the state dir, so which sessions this machine started, and
// whether they still run, survives a server restart and is the same for every instance. The server writes the file
// before it launches; bin/launch.mjs takes it over (its pid) and writes how the session ended.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export const KEEP_DAYS = 14;
// A record the launcher has not taken over this long after the launch never ran (Ghostty refused, or crashed first).
export const STARTING_MS = 60_000;
// The per-issue lock outlives a crashed Start by at most this.
export const LOCK_STALE_MS = 120_000;
export const RECORD_RE = /^([a-z0-9][a-z0-9-]*)-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const LIVE = new Set(["running", "starting"]);

/** ${XDG_STATE_HOME:-~/.local/state}/mission-control/sessions. A relative XDG_STATE_HOME is ignored, as the spec says. */
export function sessionsDir({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(base, "mission-control", "sessions");
}

/** Where a new session's record goes. Nothing is written yet. */
export function planRecord(dir, key, number) {
  const sessionId = randomUUID();
  return { path: join(dir, `${key}-${number}-${sessionId}.json`), sessionId };
}

/** Atomic replace: a reader never sees half a record. */
export function writeRecord(path, record) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(record) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** The first write of a record; refuses to overwrite one. */
export function createRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
}

/** A record read back and checked against its own file name, or null. */
export function readRecord(path) {
  const m = basename(path).match(RECORD_RE);
  if (!m) return null;
  let r;
  try {
    r = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || r.v !== 1 || r.key !== m[1] || r.number !== Number(m[2]) || r.sessionId !== m[3]) return null;
  return r;
}

/**
 * Whether the launcher that owns a record still runs: its pid is alive AND its command line holds the session id,
 * so a pid the system has reused for something else does not count. When `ps` cannot answer, a live pid counts:
 * a wrong "running" refuses a Start, a wrong "ended" allows a second session.
 */
export function launcherAlive(record) {
  return new Promise((resolve) => {
    try {
      process.kill(record.pid, 0);
    } catch (e) {
      if (e.code !== "EPERM") return resolve(false);
    }
    execFile("ps", ["-ww", "-o", "command=", "-p", String(record.pid)], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(err.code !== 1); // ps exits 1 when the pid is gone
      resolve(stdout.includes(record.sessionId));
    });
  });
}

/** running | starting | exited | ended (the launcher is gone and wrote no end: the window closed hard, or a crash). */
export async function stateOf(record, { now, alive }) {
  if (record.exitedAt) return "exited";
  if (!Number.isSafeInteger(record.pid)) return now - Date.parse(record.launchedAt) < STARTING_MS ? "starting" : "ended";
  return (await alive(record)) ? "running" : "ended";
}

/** What the board and the Start checks need from a record, newest first per issue. */
function summary(record, state) {
  const s = { state, sessionId: record.sessionId, launchedAt: record.launchedAt };
  if (record.startedAt) s.startedAt = record.startedAt;
  if (state === "exited") Object.assign(s, { exitedAt: record.exitedAt, exitCode: record.exitCode ?? null, signal: record.signal ?? null });
  if (record.note) s.note = record.note;
  if (state === "ended" && !record.pid) s.note = "the launcher never ran";
  return s;
}

/**
 * Every session of one project, newest first, with its state. Records that ended more than KEEP_DAYS ago are
 * deleted on the way. Unreadable files are skipped, never deleted: they may be another version's.
 */
export async function listSessions(dir, key, { now = Date.now(), alive = launcherAlive } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const records = [];
  for (const name of names) {
    const m = name.match(RECORD_RE);
    if (!m || m[1] !== key) continue;
    const path = join(dir, name);
    const record = readRecord(path);
    if (record) records.push({ path, record });
  }
  // In parallel: each live pid costs a `ps`, and the board waits for all of them.
  const states = await Promise.all(records.map(({ record }) => stateOf(record, { now, alive })));
  const out = [];
  records.forEach(({ path, record }, i) => {
    const last = Date.parse(record.exitedAt ?? record.startedAt ?? record.launchedAt);
    if (!LIVE.has(states[i]) && now - last > KEEP_DAYS * 86_400_000) rmSync(path, { force: true });
    else out.push({ number: record.number, ...summary(record, states[i]) });
  });
  return out.sort((a, b) => Date.parse(b.launchedAt) - Date.parse(a.launchedAt));
}

export function isLive(session) {
  return LIVE.has(session.state);
}

/**
 * A lock per issue across every server on this machine, held from the session check to the record write, so two
 * instances cannot both see no session and both launch. Returns a release function, or null when another holds it.
 */
export function lockIssue(dir, key, number, now = Date.now()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${key}-${number}.lock`);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner"), token);
      // Only the holder removes it: a Start that outlived LOCK_STALE_MS must not remove a lock taken over since.
      return () => {
        let owner = null;
        try {
          owner = readFileSync(join(path, "owner"), "utf8");
        } catch {}
        if (owner === token) rmSync(path, { recursive: true, force: true });
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age;
      try {
        age = now - statSync(path).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      if (age < LOCK_STALE_MS) return null;
      rmSync(path, { recursive: true, force: true }); // left by a server that died mid-Start
    }
  }
  return null;
}
