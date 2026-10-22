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

// ── the file is checked, not trusted ────────────────────────────────────────

test("validation refuses unknown keys and anything that looks like a token, without echoing the value", () => {
  assert.throws(() => validateProject(base({ refreshSecond: 5 })), /unknown key refreshSecond; known keys: key, title, org/);
  assert.throws(() => validateProject(base({ apiKey: "x", token: "y" })), /unknown keys apiKey, token/);
  let message = "";
  try {
    validateProject(base({ prompt: "work #{number} with ghp_abcdefghijklmnop" }));
  } catch (e) {
    message = e.message;
  }
  assert.match(message, /the value at prompt looks like a token; secrets never go in project files/);
  assert.ok(!message.includes("ghp_"), "the value is never echoed");
  assert.throws(() => validateProject(base({ layers: [{ name: "L", groups: [{ name: "sk-ant-api03-zzzzzzzz", parts: [] }] }] })), /the value at layers\[0\]\.groups\[0\]\.name looks like a token/);
  assert.throws(() => validateProject(base({ title: "github_pat_11ABCDEFG_more" })), /the value at title looks like a token/);
});

test("validation refuses line breaks where Start would pass them as one argument", () => {
  assert.throws(() => validateProject(base({ prompt: "work #{number}\nread AGENTS.md" })), /prompt must not contain a line break/);
  assert.throws(() => validateProject(base({ command: ["claude", "-w\n", "{prompt}"] })), /command\[1\] must not contain a line break/);
  assert.throws(() => validateProject(base({ localPath: "~/some\nwhere" })), /localPath must not contain a line break/);
});

test("validation: {title} is a prompt placeholder only, and command must carry {prompt}", () => {
  assert.throws(() => validateProject(base({ command: ["claude", "{title}", "{prompt}"] })), /command\[1\] must not use \{title\}/);
  assert.throws(() => validateProject(base({ command: ["claude", "-w", "issue-{number}"] })), /command must include \{prompt\}/);
  assert.doesNotThrow(() => validateProject(base({ prompt: "work #{number}: {title}" })), "{title} in the prompt is fine; it is wrapped there");
});

test("validation: onHoldPattern null turns the rule off, empty is refused", () => {
  assert.equal(validateProject(base({ onHoldPattern: null })).onHoldPattern, null);
  assert.throws(() => validateProject(base({ onHoldPattern: "" })), /onHoldPattern is empty, which would match every title/);
  assert.throws(() => validateProject(base({ onHoldPattern: 5 })), /must be a string, or null/);
});

test("validation: a Status name in two lists, and duplicate layer, group or part names, are refused", () => {
  assert.throws(() => validateProject(base({ status: { done: ["Done"], inReview: [], inProgress: ["done "], todo: [] } })), /Status "done " is in both status\.done and status\.inProgress/);
  assert.throws(() => validateProject(base({ status: { done: [" "], inReview: [], inProgress: [], todo: [] } })), /status\.done has an empty option name/);
  assert.throws(() => validateProject(base({ layers: [{ name: "L", groups: [] }, { name: "L", groups: [] }] })), /two layers are named "L"/);
  assert.throws(() => validateProject(base({ layers: [{ name: "L", groups: [{ name: "G", parts: [] }, { name: "G", parts: [] }] }] })), /two groups in L are named "G"/);
  assert.throws(() => validateProject(base({ layers: [{ name: "L", groups: [{ name: "G", parts: [{ name: "P", issues: [1] }, { name: "P", issues: [2] }] }] }] })), /two parts have the path "L \/ G \/ P"/);
  assert.doesNotThrow(() => validateProject(base({ layers: [{ name: "L", groups: [{ name: "", parts: [{ name: "P" }] }, { name: "", parts: [{ name: "Q" }] }] }] })), "unnamed groups may repeat");
  assert.throws(() => validateProject(base({ layers: [{ name: "L", groups: [{ name: "", parts: [{ name: "P" }] }, { name: "", parts: [{ name: "P" }] }] }] })), /two parts have the path "L \/ P"/, "but not with the same part path");
  assert.doesNotThrow(() => validateProject(base({ layers: [{ name: "L", groups: [{ name: "A", parts: [{ name: "P" }] }, { name: "B", parts: [{ name: "P" }] }] }] })), "named groups keep the paths apart");
});

test("validation: unknown keys inside status, start, model, layers, groups and parts are refused by path", () => {
  const layers = (extra = {}) => [{ name: "L", groups: [{ name: "G", parts: [{ name: "P", issues: [1], ...extra.part }], ...extra.group }], ...extra.layer }];
  assert.throws(() => validateProject(base({ start: { enable: true } })), /unknown key start\.enable; known keys there: enabled, terminal/);
  assert.throws(() => validateProject(base({ status: { done: [], inReview: [], inProgress: [], todo: [], inreview: [] } })), /unknown key status\.inreview/);
  assert.throws(() => validateProject(base({ command: ["claude", "{prompt}"], model: { allowed: ["opus"], defualt: "opus" } })), /unknown key model\.defualt/);
  assert.throws(() => validateProject(base({ layers: layers({ layer: { grups: [] } }) })), /unknown key layers\[0\]\.grups/);
  assert.throws(() => validateProject(base({ layers: layers({ group: { phones: true } }) })), /unknown key layers\[0\]\.groups\[0\]\.phones/);
  assert.throws(() => validateProject(base({ layers: layers({ part: { issue: [2] } }) })), /unknown key layers\[0\]\.groups\[0\]\.parts\[0\]\.issue/);
  assert.doesNotThrow(() => validateProject(base({ start: { enabled: false, terminal: "ghostty" }, command: ["claude", "{prompt}"], model: { allowed: ["opus"], default: "opus", labelPrefix: "model:" }, layers: [{ name: "L", groups: [{ name: "G", epic: 1, phone: true, parts: [{ name: "P", issues: [2] }] }] }] })), "every key the loader reads is known");
});

test("validation: with Start on, flags that take the human out of the session are refused; with Start off, Copy stays free", () => {
  for (const flag of ["--dangerously-skip-permissions", "--permission-mode", "--permission-mode=bypassPermissions", "-p", "--print", "--allowedTools", "--allowedTools=Bash", "--settings", "--settings={}", "--setting-sources", "--setting-sources=project"]) {
    assert.throws(() => validateProject(base({ start: { enabled: true }, command: ["claude", flag, "{prompt}"] })), /takes the human out of the session/, flag);
    assert.doesNotThrow(() => validateProject(base({ command: ["claude", flag, "{prompt}"] })), `${flag} with Start off`);
  }
  assert.doesNotThrow(() => validateProject(base({ start: { enabled: true }, command: ["claude", "--model", "opus", "{prompt}"] })));
  assert.equal(validateProject(base({ start: null })).start.enabled, false, "null means no start section");
  assert.throws(() => validateProject(base({ start: 5 })), /start must be an object/);
});
