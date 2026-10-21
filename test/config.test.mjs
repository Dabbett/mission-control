import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, validateProject, loadProjects, resolveConfigDir, pickProject } from "../src/config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function base(overrides = {}) {
  return {
    key: "p",
    org: "o",
    projectNumber: 1,
    repo: "o/r",
    localPath: "~/somewhere",
    status: { done: ["Done"], inReview: ["In review"], inProgress: ["In progress"], todo: ["Todo"] },
    prompt: "work #{number}",
    command: ["claude", "{prompt}"],
    layers: [],
    ...overrides,
  };
}

test("expandHome expands ~ and ~/ only", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/x"), join(homedir(), "x"));
  assert.equal(expandHome("/abs/~/x"), "/abs/~/x");
});

test("localPath is expanded and absolute", () => {
  const p = validateProject(base());
  assert.ok(isAbsolute(p.localPath));
  assert.equal(p.localPath, join(homedir(), "somewhere"));
});

test("defaults are applied", () => {
  const p = validateProject(base());
  assert.equal(p.refreshSeconds, 60);
  assert.equal(p.decisionType, "Decision");
  assert.equal(p.epicLabel, "epic");
  assert.equal(p.start.enabled, false);
  assert.ok(p.onHoldPattern.test("[On hold] x"));
  assert.ok(p.onHoldPattern.test("[on HOLD] x"));
  assert.ok(!p.onHoldPattern.test("x [On hold]"));
});

test("custom status option names map through config", () => {
  const p = validateProject(base({ status: { done: ["shipped"], inReview: ["verifying"], inProgress: ["doing", "this-sprint"], todo: ["queued"] } }));
  assert.deepEqual(p.status.inProgress, ["doing", "this-sprint"]);
});

test("invalid configs are refused with a reason", () => {
  assert.throws(() => validateProject(base({ key: "Bad Key" })), /key must be/);
  assert.throws(() => validateProject(base({ repo: "nope" })), /owner\/name/);
  assert.throws(() => validateProject(base({ refreshSeconds: 5 })), /at least 15/);
  assert.throws(() => validateProject(base({ status: { done: ["Done"] } })), /status.inReview/);
  assert.throws(() => validateProject(base({ command: [] })), /command must be/);
  assert.throws(() => validateProject(base({ start: { enabled: true, terminal: "iterm" } })), /not supported/);
  assert.throws(() => validateProject(base({ onHoldPattern: "(" })), /regular expression/);
  assert.throws(() => validateProject(base({ layers: [{ name: "L", groups: [{ parts: [{ name: "P", issues: [0] }] }] }] })), /positive integers/);
  assert.throws(() => validateProject(base({ layers: [{ name: "L", groups: [{ epic: -1, parts: [] }] }] })), /epic must be/);
  assert.throws(() => validateProject(base({ layers: [{ name: "L", groups: [null] }] })), /must be an object/);
  assert.throws(() => validateProject(base({ start: { enabled: true }, command: ["sh", "-c", "{prompt}"] })), /command\[0\] to be "claude"/);
  assert.equal(validateProject(base({ start: { enabled: true } })).start.enabled, true);
});

test("model: optional, allowlisted, and never shaped like a flag", () => {
  assert.equal(validateProject(base()).model, null);
  const m = validateProject(base({ model: { default: "opus", allowed: ["opus", "sonnet"] } })).model;
  assert.deepEqual(m, { default: "opus", allowed: ["opus", "sonnet"], labelPrefix: "model:" });
  assert.equal(validateProject(base({ model: { allowed: ["sonnet"] } })).model.default, null);
  assert.throws(() => validateProject(base({ model: "opus" })), /model must be an object/);
  assert.throws(() => validateProject(base({ model: { allowed: [] } })), /non-empty array/);
  assert.throws(() => validateProject(base({ model: { allowed: ["--dangerously-skip-permissions"] } })), /not a model name/);
  assert.throws(() => validateProject(base({ model: { allowed: ["Opus 5"] } })), /not a model name/);
  assert.throws(() => validateProject(base({ model: { default: "fable", allowed: ["opus"] } })), /not in model\.allowed/);
  assert.throws(() => validateProject(base({ model: { allowed: ["opus"], labelPrefix: "" } })), /labelPrefix/);
  assert.throws(() => validateProject(base({ command: ["codex", "{prompt}"], model: { allowed: ["opus"] } })), /command\[0\] to be "claude"/);
  assert.throws(() => validateProject(base({ command: ["claude", "--model", "x", "{prompt}"], model: { allowed: ["opus"] } })), /conflict/);
  assert.throws(() => validateProject(base({ command: ["claude", "--model=sonnet", "{prompt}"], model: { allowed: ["opus"] } })), /conflict/);
  assert.throws(() => validateProject(base({ model: { allowed: ["opus"], labelPrefix: 3 } })), /labelPrefix/);
  assert.throws(() => validateProject(base({ model: null })), /model must be an object/);
});

test("a group can be marked as the phone strip", () => {
  const p = validateProject(base({ layers: [{ name: "L", groups: [{ name: "M", phone: true, parts: [] }, { name: "A", parts: [] }] }] }));
  assert.deepEqual(p.layers[0].groups.map((g) => g.phone), [true, false]);
});

test("epics are collected from groups and part issues are de-duplicated", () => {
  const p = validateProject(base({ layers: [{ name: "L", groups: [{ name: "G", epic: 9, parts: [{ name: "P", issues: [1, 1, 2] }] }] }] }));
  assert.deepEqual(p.epics, [9]);
  assert.deepEqual(p.layers[0].groups[0].parts[0].issues, [1, 2]);
});

test("the shipped projects/ folder loads and holds only the example", () => {
  const map = loadProjects(join(root, "projects"));
  assert.deepEqual([...map.keys()], ["example"]);
  const s = map.get("example");
  assert.equal(s.org, "example-org");
  assert.equal(s.repo, "example-org/example-app");
  assert.equal(s.projectNumber, 1);
  assert.deepEqual(s.epics.sort(), [1, 2, 3]);
  assert.ok(s.command.includes("{prompt}"));
});

test("resolveConfigDir: an explicit dir wins, then the user's config dir when it holds a file, else the repo's projects/", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-config-"));
  const empty = resolveConfigDir({ env: {}, home, root });
  assert.deepEqual(empty, { dir: join(root, "projects"), source: "repo", userDir: join(home, ".config", "mission-control", "projects") });

  mkdirSync(empty.userDir, { recursive: true });
  assert.equal(resolveConfigDir({ env: {}, home, root }).source, "repo", "an empty user dir does not count");
  writeFileSync(join(empty.userDir, "mine.json"), "{}");
  assert.deepEqual(resolveConfigDir({ env: {}, home, root }), { dir: empty.userDir, source: "user", userDir: empty.userDir });

  const xdg = join(home, "xdg");
  mkdirSync(join(xdg, "mission-control", "projects"), { recursive: true });
  writeFileSync(join(xdg, "mission-control", "projects", "x.json"), "{}");
  assert.equal(resolveConfigDir({ env: { XDG_CONFIG_HOME: xdg }, home, root }).dir, join(xdg, "mission-control", "projects"));

  const explicit = join(home, "elsewhere");
  mkdirSync(explicit);
  assert.deepEqual(resolveConfigDir({ explicit, env: {}, home, root }).source, "explicit");
  assert.equal(resolveConfigDir({ explicit: "~/elsewhere", env: {}, home, root }).dir, explicit, "~ expands against the given home");
  assert.equal(resolveConfigDir({ explicit: null, env: { XDG_CONFIG_HOME: "~/xdg" }, home, root }).dir, join(xdg, "mission-control", "projects"));
  assert.throws(() => resolveConfigDir({ explicit: join(home, "missing"), env: {}, home, root }), /does not exist/);
});

test("pickProject: the requested key must exist; otherwise the only project, else the first by file order", () => {
  const map = loadProjects(join(root, "projects"));
  assert.equal(pickProject(map, null), "example");
  assert.equal(pickProject(map, "example"), "example");
  assert.throws(() => pickProject(map, "nope"), /no project "nope"\. Available: example/);
  const two = new Map([["b", {}], ["a", {}]]);
  assert.equal(pickProject(two, null), "b");
});
