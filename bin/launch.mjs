#!/usr/bin/env node
// Runs inside the terminal window that Start opened. Sets the working directory and runs claude.
// Usage: node launch.mjs --cwd <absolute dir> --record <session record> -- claude [args...]
// Accepts only `claude` as the command, refuses flags that would take the human out of the session, and refuses to
// run when a variable in BILLING_ENV is set (the session would bill an API account or another provider, not the
// user's own Claude login). On any failure it prints why and waits for a key, so the window stays readable.
// The session record (ADR 0003) is taken over first and gets how the session ended, refusals included; the
// session id in it goes to claude as --session-id.
import { spawn } from "node:child_process";
import { existsSync, readSync, statSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute } from "node:path";
import { dangerousFlag, SESSION_FLAGS } from "../src/claude-flags.mjs";
import { readRecord, writeRecord } from "../src/sessions.mjs";

const BILLING_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
// After a hang-up, claude gets this long to exit before the launcher kills it, so a recorded end is a real end.
// MC_HANGUP_GRACE_MS shortens it for the tests; the server's allowlisted environment never carries it.
// It can only shorten the wait, and not below 100 ms, so a stray value in a shell profile cannot cut a session short.
const grace = Number(process.env.MC_HANGUP_GRACE_MS);
const HANGUP_GRACE_MS = grace >= 100 && grace <= 10_000 ? grace : 10_000;

let recordPath = null;
let record = null;

function waitForKey() {
  if (!process.stdin.isTTY) return;
  process.stderr.write("\nPress any key to close.\n");
  try {
    process.stdin.setRawMode(true);
    readSync(0, Buffer.alloc(1));
  } catch {}
}

/** Writes how the session ended, once. A failed write is reported, never fatal: the session is over either way. */
function recordEnd(exitCode, signal, note) {
  if (!record || record.exitedAt) return;
  record = { ...record, exitedAt: new Date().toISOString(), exitCode, signal, ...(note ? { note } : {}) };
  try {
    writeRecord(recordPath, record);
  } catch (e) {
    process.stderr.write(`mission control launcher: could not write the end of the session record: ${e.message}\n`);
  }
}

function fail(message, code = 2) {
  process.stderr.write(`mission control launcher: ${message}\n`);
  recordEnd(code, null, message);
  waitForKey();
  process.exit(code);
}

const args = process.argv.slice(2);
if (args[0] !== "--cwd" || typeof args[1] !== "string" || args[2] !== "--record" || typeof args[3] !== "string" || args[4] !== "--") {
  fail("usage: --cwd <absolute dir> --record <session record> -- claude [args...]");
}
// The record is taken before anything else can refuse, so a refusal shows on the dashboard instead of only here.
if (!isAbsolute(args[3])) fail("the session record path must be absolute");
const found = readRecord(args[3]);
if (!found) fail(`not a session record: ${args[3]}`);
if (found.pid) fail("this session record was already taken; press Start again for a new session");
recordPath = args[3];
record = { ...found, pid: process.pid, startedAt: new Date().toISOString() };
try {
  writeRecord(recordPath, record);
} catch (e) {
  record = null; // nothing to update: without the record the dashboard cannot see this session, so it does not run
  fail(`cannot write the session record (${e.message}), so the dashboard could not see this session`);
}

const cwd = args[1];
if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) fail(`working directory is not an absolute existing directory: ${cwd}`);
const command = args[5];
if (command !== "claude") fail(`only the claude command may be launched, got: ${String(command)}`);
const rest = args.slice(6);
const bad = dangerousFlag(rest);
if (bad) fail(`refusing ${bad}: a session started from the dashboard must ask before it acts`);
const own = rest.find((a) => SESSION_FLAGS.test(a));
if (own) fail(`refusing ${own}: every session from the dashboard is a new one, with the id from its record`);
// Names only, never values: a key must not end up on screen.
const billing = BILLING_ENV.filter((k) => process.env[k]);
if (billing.length) {
  fail(`${billing.join(", ")} ${billing.length > 1 ? "are" : "is"} set in this terminal's environment, so the session would bill an API account or another provider instead of your Claude login. Unset ${billing.length > 1 ? "them" : "it"} (check your shell profile) and start again.`);
}

const child = spawn("claude", ["--session-id", record.sessionId, ...rest], { cwd, stdio: "inherit" });
// Ctrl-C and Ctrl-\ reach claude too, which decides what they mean; the launcher waits for it either way.
for (const sig of ["SIGINT", "SIGQUIT"]) process.on(sig, () => {});
// A closed window hangs up the launcher and claude together. Wait for claude, so the end is recorded with its status.
let killedAfter = null;
for (const sig of ["SIGHUP", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
    // A claude that ignores the signal is killed, and the end is recorded from its exit, never before it.
    setTimeout(() => {
      if (child.kill("SIGKILL")) killedAfter = sig;
    }, HANGUP_GRACE_MS).unref();
  });
}
child.on("error", (e) => fail(e.code === "ENOENT" ? "claude is not on PATH in this terminal" : e.message, e.code === "ENOENT" ? 127 : 1));
child.on("exit", (code, signal) => {
  recordEnd(code, signal, killedAfter ? `killed: claude did not exit within ${HANGUP_GRACE_MS / 1000} s of ${killedAfter}` : undefined);
  if (signal) process.exit(128 + (constants.signals[signal] ?? 1));
  if (code !== 0) {
    process.stderr.write(`\nclaude exited with status ${code}.\n`);
    waitForKey();
  }
  process.exit(code ?? 1);
});
