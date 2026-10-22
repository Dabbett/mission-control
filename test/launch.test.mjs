import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./helpers.mjs";

const launcher = join(root, "bin", "launch.mjs");

// ANTHROPIC_API_KEY is dropped from the inherited environment, so a key in the developer's shell does not fail every case.
function run(args, env = {}) {
  const base = { ...process.env };
  delete base.ANTHROPIC_API_KEY;
  return spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

test("launch: refuses anything but claude, relative or missing cwd, and bad usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  assert.notEqual(run(["--cwd", dir, "--", "ls"]).status, 0);
  assert.match(run(["--cwd", dir, "--", "ls"]).stderr, /only the claude command/);
  assert.match(run(["--cwd", dir, "--", "/usr/bin/claude"]).stderr, /only the claude command/);
  assert.match(run(["--cwd", "relative/dir", "--", "claude"]).stderr, /absolute existing directory/);
  assert.match(run(["--cwd", join(dir, "missing"), "--", "claude"]).stderr, /absolute existing directory/);
  assert.match(run(["--", "claude"]).stderr, /usage/);
  assert.match(run([]).stderr, /usage/);
});

test("launch: refuses flags that take the human out of the session, whatever the config said", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  for (const flag of ["--dangerously-skip-permissions", "--permission-mode=bypassPermissions", "--permission-mode", "-p", "--print", "--allowedTools=Bash", "--allowed-tools"]) {
    const r = run(["--cwd", dir, "--", "claude", "-w", "issue-1", flag, "x"]);
    assert.notEqual(r.status, 0, flag);
    assert.match(r.stderr, new RegExp(`refusing ${flag.replace(/[-=]/g, "\\$&")}`), flag);
  }
});

test("launch: refuses to run when ANTHROPIC_API_KEY is set, and never prints the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  const r = run(["--cwd", dir, "--", "claude"], { ANTHROPIC_API_KEY: "sk-ant-should-not-appear" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ANTHROPIC_API_KEY is set/);
  assert.ok(!(r.stdout + r.stderr).includes("sk-ant-should-not-appear"));
});

test("launch: runs claude from PATH with the given cwd and argv, and passes the exit status through", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  for (const d of [bin, work]) spawnSync("mkdir", ["-p", d]);
  const record = join(dir, "record.json");
  const fake = join(bin, "claude");
  writeFileSync(fake, `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(process.argv.includes("--fail") ? 3 : 0);\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const hostile = `Title with "quotes" and $(touch ${join(dir, "pwned")}) and ; rm -rf x`;
  const ok = run(["--cwd", work, "--", "claude", "-w", "issue-1", hostile], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { argv: ["-w", "issue-1", hostile], cwd: realpathSync(work) });
  assert.ok(!existsSync(join(dir, "pwned")));
  const failed = run(["--cwd", work, "--", "claude", "--fail"], env);
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /exited with status 3/);
});

test("launch: a missing claude binary is reported, not swallowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-launch-"));
  const r = run(["--cwd", dir, "--", "claude"], { PATH: "/nonexistent" });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /not on PATH/);
});
