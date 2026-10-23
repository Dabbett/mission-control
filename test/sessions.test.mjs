import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecord, KEEP_DAYS, launcherAlive, listSessions, planRecord, readRecord, sessionsDir, writeRecord } from "../src/sessions.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "mc-sessions-"));
const NOW = Date.parse("2026-10-23T12:00:00Z");

function make(d, number, fields, key = "example") {
  const { path, sessionId } = planRecord(d, key, number);
  createRecord(path, { v: 1, key, number, sessionId, launchedAt: "2026-10-23T11:00:00.000Z", cwd: "/r", ...fields });
  return path;
}

test("sessions: the dir follows XDG_STATE_HOME when it is absolute, else ~/.local/state", () => {
  assert.equal(sessionsDir({ env: { XDG_STATE_HOME: "/s" }, home: "/h" }), "/s/mission-control/sessions");
  assert.equal(sessionsDir({ env: { XDG_STATE_HOME: "rel" }, home: "/h" }), "/h/.local/state/mission-control/sessions");
  assert.equal(sessionsDir({ env: {}, home: "/h" }), "/h/.local/state/mission-control/sessions");
});

test("sessions: a record must match its own file name, and a new one never overwrites", () => {
  const d = dir();
  const path = make(d, 6, {});
  assert.equal(readRecord(path).number, 6);
  writeRecord(path, { ...readRecord(path), number: 7 });
  assert.equal(readRecord(path), null, "contents that disagree with the name are not a record");
  assert.throws(() => createRecord(path, {}), /EEXIST/);
  writeFileSync(join(d, "example-6-0000.json"), "{}");
  assert.equal(readRecord(join(d, "example-6-0000.json")), null);
});

test("sessions: states, newest first, other projects and unreadable files skipped, old ends pruned", async () => {
  const d = dir();
  make(d, 1, { launchedAt: "2026-10-23T11:59:30.000Z" }); // starting
  make(d, 2, { launchedAt: "2026-10-23T10:00:00.000Z" }); // never ran
  make(d, 3, { pid: 11, startedAt: "2026-10-23T09:00:00.000Z", launchedAt: "2026-10-23T09:00:00.000Z" }); // running
  make(d, 4, { pid: 12, startedAt: "2026-10-23T08:00:00.000Z", launchedAt: "2026-10-23T08:00:00.000Z" }); // ended
  make(d, 5, { pid: 13, launchedAt: "2026-10-23T07:00:00.000Z", exitedAt: "2026-10-23T07:30:00.000Z", exitCode: 1, signal: null, note: "why" });
  const old = make(d, 6, { pid: 14, launchedAt: "2026-09-01T00:00:00.000Z", exitedAt: "2026-09-01T01:00:00.000Z", exitCode: 0 });
  const oldRunning = make(d, 7, { pid: 11, startedAt: "2026-09-01T00:00:00.000Z", launchedAt: "2026-09-01T00:00:00.000Z" });
  make(d, 8, {}, "other");
  writeFileSync(join(d, "example-9-00000000-0000-0000-0000-000000000000.json"), "not json");
  const list = await listSessions(d, "example", { now: NOW, alive: async (r) => r.pid === 11 });
  assert.deepEqual(list.map((s) => [s.number, s.state]), [[1, "starting"], [2, "ended"], [3, "running"], [4, "ended"], [5, "exited"], [7, "running"]]);
  assert.equal(list[1].note, "the launcher never ran");
  assert.deepEqual([list[4].exitCode, list[4].note], [1, "why"]);
  assert.ok(!existsSync(old), `ended more than ${KEEP_DAYS} days ago: deleted`);
  assert.ok(existsSync(oldRunning), "a running session is never pruned");
  assert.ok(existsSync(join(d, "example-9-00000000-0000-0000-0000-000000000000.json")), "an unreadable file is left alone");
  assert.deepEqual(await listSessions(join(d, "missing"), "example"), []);
});

test("sessions: alive needs the pid AND the session id on its command line, so a reused pid does not count", async () => {
  const { sessionId } = planRecord("/x", "example", 1);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", sessionId], { stdio: "ignore" });
  try {
    await new Promise((r) => child.once("spawn", r));
    assert.equal(await launcherAlive({ pid: child.pid, sessionId }), true);
    assert.equal(await launcherAlive({ pid: child.pid, sessionId: planRecord("/x", "example", 1).sessionId }), false, "another process holds the pid");
  } finally {
    child.kill();
  }
  await new Promise((r) => child.once("exit", r));
  assert.equal(await launcherAlive({ pid: child.pid, sessionId }), false);
});
