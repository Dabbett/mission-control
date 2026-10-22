#!/usr/bin/env node
// Runs inside the terminal window that Start opened. Sets the working directory and runs claude.
// Usage: node launch.mjs --cwd <absolute dir> -- claude [args...]
// Accepts only `claude` as the command, refuses flags that would take the human out of the session, and refuses to
// run when ANTHROPIC_API_KEY is set (the session would bill the API, not the subscription). On any failure it prints
// why and waits for a key, so the window stays readable.
import { spawnSync } from "node:child_process";
import { existsSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dangerousFlag } from "../src/claude-flags.mjs";

function waitForKey() {
  if (!process.stdin.isTTY) return;
  process.stderr.write("\nPress any key to close.\n");
  try {
    process.stdin.setRawMode(true);
    readSync(0, Buffer.alloc(1));
  } catch {}
}

function fail(message, code = 2) {
  process.stderr.write(`mission control launcher: ${message}\n`);
  waitForKey();
  process.exit(code);
}

const args = process.argv.slice(2);
if (args[0] !== "--cwd" || typeof args[1] !== "string" || args[2] !== "--") fail("usage: --cwd <absolute dir> -- claude [args...]");
const cwd = args[1];
if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) fail(`working directory is not an absolute existing directory: ${cwd}`);
const command = args[3];
if (command !== "claude") fail(`only the claude command may be launched, got: ${String(command)}`);
const rest = args.slice(4);
const bad = dangerousFlag(rest);
if (bad) fail(`refusing ${bad}: a session started from the dashboard must ask before it acts`);
if (process.env.ANTHROPIC_API_KEY) {
  fail("ANTHROPIC_API_KEY is set in this terminal's environment, so the session would bill the API instead of your Claude subscription. Unset it (check your shell profile) and start again.");
}

const result = spawnSync("claude", rest, { cwd, stdio: "inherit" });
if (result.error) {
  if (result.error.code === "ENOENT") fail("claude is not on PATH in this terminal", 127);
  fail(result.error.message, 1);
}
if (result.status !== 0) {
  process.stderr.write(`\nclaude exited with status ${result.status}.\n`);
  waitForKey();
  process.exit(result.status ?? 1);
}
