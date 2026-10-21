import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { root } from "./helpers.mjs";

const mc = join(root, "bin", "mc");

function env(home, extra = {}) {
  return { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, "state"), MC_NO_OPEN: "1", ...extra };
}

function run(args, home, extra = {}) {
  return spawnSync("bash", [mc, ...args], { encoding: "utf8", env: env(home, extra) });
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

test("mc: executable bits, bash syntax and usage", () => {
  for (const f of [mc, join(root, "raycast", "mission-control.sh"), join(root, "raycast", "mission-control-stop.sh")]) {
    assert.ok(statSync(f).mode & 0o111, `${f} is not executable`);
    assert.equal(spawnSync("bash", ["-n", f]).status, 0, `${f} syntax`);
  }
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const r = run(["nope"], home);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: mc/);
});

test("mc: status on an unused port says not running", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const r = run(["status"], home, { MC_PORT: String(await freePort()) });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not running/);
});

test("mc: start, status and stop drive the real server on a random port", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const port = String(await freePort());
  try {
    const started = run(["start"], home, { MC_PORT: port });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, new RegExp(`mission control: http://127.0.0.1:${port}/$`, "m"), "no MC_PROJECT: the bare URL, and the server opens its only project");
    const status = run(["status"], home, { MC_PORT: port });
    assert.equal(status.status, 0);
    const named = run(["status"], home, { MC_PORT: port, MC_PROJECT: "example" });
    assert.equal(named.status, 0);
    assert.match(named.stdout, new RegExp(`http://127.0.0.1:${port}/\\?project=example`));
    assert.equal(run(["status"], home, { MC_PORT: port, MC_PROJECT: "other" }).status, 1, "a project the server does not know is not running");
    const again = run(["start"], home, { MC_PORT: port });
    assert.equal(again.status, 0, "a second start just reports the running server");
    const log = run(["log", "20"], home, { MC_PORT: port });
    assert.match(log.stdout, /mission control on http:\/\/127\.0\.0\.1/);
  } finally {
    const stopped = run(["stop"], home, { MC_PORT: port });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/);
  }
  assert.equal(run(["status"], home, { MC_PORT: port }).status, 1);
});

test("mc: stop never kills a listener that is not mission control", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const port = await freePort();
  const other = spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("[]")).listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000)`], { stdio: "ignore" });
  t.after(() => other.kill());
  for (let i = 0; i < 50; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = run(["stop"], home, { MC_PORT: String(port) });
  assert.equal(stop.status, 1);
  assert.match(stop.stderr, /not mission control/);
  assert.equal(other.exitCode, null, "the other process is still alive");
  const start = run(["start"], home, { MC_PORT: String(port) });
  assert.equal(start.status, 1);
  assert.match(start.stderr, /taken by something that is not mission control/);
});

test("mc: install writes the symlink and a safe app bundle under HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const r = run(["install"], home, { MC_PORT: "7777", MC_PROJECT: "example" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(join(home, ".local", "bin", "mc")), mc);
  const app = join(home, "Applications", "MC Dashboard.app", "Contents");
  const plist = readFileSync(join(app, "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>MC Dashboard<\/string>/);
  assert.match(plist, /LSUIElement/);
  const exe = join(app, "MacOS", "MC Dashboard");
  assert.ok(statSync(exe).mode & 0o111);
  const script = readFileSync(exe, "utf8");
  assert.match(script, /^#!\/bin\/bash\n/);
  assert.match(script, /export MC_PORT=7777 MC_PROJECT=example\n/);
  assert.match(script, new RegExp(`exec ${mc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} open\n$`));

  const plain = run(["install"], home, { MC_PORT: "7778" });
  assert.equal(plain.status, 0, plain.stderr);
  const plainScript = readFileSync(exe, "utf8");
  assert.match(plainScript, /export MC_PORT=7778\n/);
  assert.doesNotMatch(plainScript, /MC_PROJECT/, "no MC_PROJECT in force, none baked in");
});

test("mc: refuses a malformed port or project key before doing anything", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  assert.match(run(["status"], home, { MC_PORT: "80;id" }).stderr, /MC_PORT must be/);
  assert.match(run(["status"], home, { MC_PROJECT: "a.b&c" }).stderr, /MC_PROJECT must be/);
});

test("raycast script commands carry the required metadata and call mc", () => {
  for (const f of ["mission-control.sh", "mission-control-stop.sh"]) {
    const text = readFileSync(join(root, "raycast", f), "utf8");
    assert.match(text, /@raycast\.schemaVersion 1/);
    assert.match(text, /@raycast\.title /);
    assert.match(text, /@raycast\.mode silent/);
    assert.match(text, /exec "\$HOME\/\.local\/bin\/mc" (open|stop)/);
  }
});
