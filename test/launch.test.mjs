import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./helpers.mjs";
import { createRecord, planRecord, readRecord } from "../src/sessions.mjs";

const launcher = join(root, "bin", "launch.mjs");

// The billing variables are dropped from the inherited environment, so one in the developer's shell does not fail every case.
const BILLING = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
function baseEnv(env) {
  const base = { ...process.env };
  for (const k of BILLING) delete base[k];
  return { ...base, ...env };
}
function run(args, env = {}) {
  return spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", env: baseEnv(env), stdio: ["ignore", "pipe", "pipe"] });
}

/** A fresh record as the server writes it before the launch; returns its path. */
function newRecord(number = 1) {
  const dir = mkdtempSync(join(tmpdir(), "mc-sessions-"));
  const { path, sessionId } = planRecord(dir, "example", number);
  createRecord(path, { v: 1, key: "example", number, sessionId, launchedAt: new Date().toISOString(), cwd: dir });
  return path;
}

/** `--cwd <dir> --record <fresh record> -- <rest>` */
const withRecord = (cwd, ...rest) => ["--cwd", cwd, "--record", newRecord(), "--", ...rest];
const recordIn = (args) => readRecord(args[3]);

/** A fake claude on PATH that writes its argv and cwd to record.json, exits 3 on --fail and waits on --wait. */
function fakeClaude(dir) {
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  const out = join(dir, "record.json");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nif (process.argv.includes("--wait")) setInterval(() => {}, 1000);\nelse process.exit(process.argv.includes("--fail") ? 3 : 0);\n`);
  chmodSync(join(bin, "claude"), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH}` }, out };
}

test("launch: refuses anything but claude, relative or missing cwd, and bad usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  assert.notEqual(run(withRecord(dir, "ls")).status, 0);
  assert.match(run(withRecord(dir, "ls")).stderr, /only the claude command/);
  assert.match(run(withRecord(dir, "/usr/bin/claude")).stderr, /only the claude command/);
  assert.match(run(withRecord("relative/dir", "claude")).stderr, /absolute existing directory/);
  assert.match(run(withRecord(join(dir, "missing"), "claude")).stderr, /absolute existing directory/);
  assert.match(run(["--cwd", dir, "--", "claude"]).stderr, /usage/, "no record");
  assert.match(run(["--", "claude"]).stderr, /usage/);
  assert.match(run([]).stderr, /usage/);
});

test("launch: refuses flags that take the human out of the session, whatever the config said", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  for (const flag of ["--dangerously-skip-permissions", "--permission-mode=bypassPermissions", "--permission-mode", "-p", "--print", "--allowedTools=Bash", "--allowed-tools", "--settings", "--setting-sources=project", "--allow-dangerously-skip-permissions", "-cp"]) {
    const r = run(withRecord(dir, "claude", "-w", "issue-1", flag, "x"));
    assert.notEqual(r.status, 0, flag);
    assert.match(r.stderr, new RegExp(`refusing ${flag.replace(/[-=]/g, "\\$&")}`), flag);
  }
});

test("launch: refuses to run while a variable that redirects billing is set, naming it and never printing its value", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  for (const k of BILLING) {
    const r = run(withRecord(dir, "claude"), { [k]: "value-should-not-appear" });
    assert.notEqual(r.status, 0, k);
    assert.match(r.stderr, new RegExp(`${k} is set`), k);
    assert.ok(!(r.stdout + r.stderr).includes("value-should-not-appear"), k);
  }
  const two = run(withRecord(dir, "claude"), { ANTHROPIC_API_KEY: "x", CLAUDE_CODE_USE_BEDROCK: "1" });
  assert.match(two.stderr, /ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK are set/);
});

test("launch: runs claude from PATH with the given cwd, the record's session id and argv, and passes the exit status through", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  const work = join(dir, "work");
  spawnSync("mkdir", ["-p", work]);
  const { env, out } = fakeClaude(dir);
  const hostile = `Title with "quotes" and $(touch ${join(dir, "pwned")}) and ; rm -rf x`;
  const args = withRecord(work, "claude", "-w", "issue-1", hostile);
  const ok = run(args, env);
  assert.equal(ok.status, 0, ok.stderr);
  const rec = recordIn(args);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { argv: ["--session-id", rec.sessionId, "-w", "issue-1", hostile], cwd: realpathSync(work) });
  assert.ok(!existsSync(join(dir, "pwned")));
  assert.ok(Number.isSafeInteger(rec.pid) && rec.startedAt && rec.exitedAt, "taken over and ended");
  assert.equal(rec.exitCode, 0);
  const failArgs = withRecord(work, "claude", "--fail");
  const failed = run(failArgs, env);
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /exited with status 3/);
  assert.equal(recordIn(failArgs).exitCode, 3);
});

test("launch: a refusal is written into the record, so the dashboard shows why", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  const args = withRecord(dir, "claude", "--print", "x");
  assert.equal(run(args).status, 2);
  const rec = recordIn(args);
  assert.equal(rec.exitCode, 2);
  assert.match(rec.note, /refusing --print/);
  const billing = withRecord(dir, "claude");
  run(billing, { ANTHROPIC_API_KEY: "value-should-not-appear" });
  assert.ok(!readFileSync(billing[3], "utf8").includes("value-should-not-appear"));
  const own = withRecord(dir, "claude", "--session-id", "x");
  assert.match(run(own).stderr, /refusing --session-id/);
});

test("launch: a record that is not one, or was already taken, is refused before claude runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  const { env, out } = fakeClaude(dir);
  const bogus = join(dir, "example-1-not-a-uuid.json");
  writeFileSync(bogus, "{}");
  assert.match(run(["--cwd", dir, "--record", bogus, "--", "claude"], env).stderr, /not a session record/);
  assert.match(run(["--cwd", dir, "--record", "relative.json", "--", "claude"], env).stderr, /must be absolute/);
  const args = withRecord(dir, "claude");
  assert.equal(run(args, env).status, 0);
  const again = run(args, env);
  assert.match(again.stderr, /already taken/);
  assert.equal(recordIn(args).exitCode, 0, "the first session's end is not overwritten by the refused second");
  void out;
});

test("launch: a closed window (hang-up) is recorded with the signal once claude exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  const { env, out } = fakeClaude(dir);
  const args = withRecord(dir, "claude", "--wait");
  const child = spawn(process.execPath, [launcher, ...args], { env: baseEnv(env), stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(out), "claude started");
  assert.equal(recordIn(args).pid, child.pid);
  assert.equal(recordIn(args).exitedAt, undefined, "running: no end yet");
  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
    child.kill("SIGHUP");
  });
  assert.equal(code, 129);
  const rec = recordIn(args);
  assert.equal(rec.signal, "SIGHUP");
  assert.equal(rec.exitCode, null);
});

test("launch: a missing claude binary is reported, not swallowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  const args = withRecord(dir, "claude");
  const r = run(args, { PATH: "/nonexistent" });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /not on PATH/);
  assert.equal(recordIn(args).exitCode, 127);
});
