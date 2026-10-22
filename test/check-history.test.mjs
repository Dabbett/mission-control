import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedEmailTest, checkHistory, revArgsFor, NOREPLY } from "../scripts/check-history.mjs";

// Addresses are assembled here, not written out, so this file itself passes the publish guard's e-mail pattern.
const addr = (local, domain) => `${local}@${domain}`;
const NOREPLY_ADDRESS = addr("98765+someone", "users.noreply.github.com");
const COMPANY = addr("person", "company.example");
const patterns = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i, /acme/i];

/** A throwaway repository with no user or system git config, so nothing signs or rewrites commits. Removed after the test. */
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "mc-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, "nogitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args, { email = NOREPLY_ADDRESS, name = "someone" } = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...base, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
  git(["init", "-q", "-b", "main"]);
  const commit = (message, opts) => {
    git(["commit", "-q", "--allow-empty", "-m", message], opts);
    return git(["rev-parse", "HEAD"]).trim();
  };
  return { dir, commit };
}

test("revArgsFor: HEAD is the last commit, a range is itself, an all-zeros or empty left side is everything", () => {
  assert.deepEqual(revArgsFor("HEAD"), ["-1", "HEAD"]);
  assert.deepEqual(revArgsFor("abc..def"), ["abc..def"]);
  assert.deepEqual(revArgsFor(`${"0".repeat(40)}..def`), ["def"]);
  assert.deepEqual(revArgsFor("..def"), ["def"]);
});

test("allowedEmailTest: GitHub noreply, GitHub bot senders and generic no-reply pass; MC_ALLOWED_EMAILS widens, never replaces", () => {
  const plain = allowedEmailTest();
  assert.ok(plain(NOREPLY_ADDRESS));
  assert.ok(plain(addr("noreply", "github.com")));
  assert.ok(plain(addr("support", "github.com")), "bots sign off with it");
  assert.ok(!plain(addr("someone", "github.com")), "a person at that domain is not a bot");
  assert.ok(!plain(addr("someone", "github.com.example")), "the domain match is anchored");
  assert.ok(plain(addr("no-reply", "anthropic.com")));
  assert.ok(!plain(COMPANY));
  const widened = allowedEmailTest("@company\\.example$");
  assert.ok(widened(COMPANY));
  assert.ok(widened(NOREPLY_ADDRESS), "the default stays allowed");
  assert.ok(!widened(addr("someone", "elsewhere.example")));
  assert.ok(NOREPLY.test(addr("NOREPLY", "example.org")), "case-insensitive");
  assert.throws(() => allowedEmailTest("(secret"), (e) => e.message === "MC_ALLOWED_EMAILS is not a valid regular expression", "a bad pattern is never echoed");
});

test("checkHistory: clean commits pass; a non-allowed e-mail and a denylisted word in a message are problems", (t) => {
  const { dir, commit } = repo(t);
  commit("init");
  const bad = commit("second, by a person", { email: COMPANY });
  const named = commit("mention Acme here");
  const isAllowedEmail = allowedEmailTest();

  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD~2", patterns, isAllowedEmail }), { commits: 1, problems: [] });
  const r = checkHistory({ repo: dir, range: `${"0".repeat(40)}..HEAD`, patterns, isAllowedEmail });
  assert.equal(r.commits, 3, "an all-zeros left side checks the whole history");
  assert.deepEqual(r.problems, [
    `${named.slice(0, 7)}: message line 1 matches denylist pattern #2`,
    `${bad.slice(0, 7)}: author e-mail is not an allowed (noreply) address`,
    `${bad.slice(0, 7)}: committer e-mail is not an allowed (noreply) address`,
  ]);
  assert.equal(checkHistory({ repo: dir, range: "HEAD", patterns, isAllowedEmail }).problems.length, 1, "HEAD is the last commit only");
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD~1..HEAD~1", patterns, isAllowedEmail }), { commits: 0, problems: [] });
});

test("checkHistory: a denylisted name in an e-mail domain fails even when the address is allowed, by default or by MC_ALLOWED_EMAILS", (t) => {
  const { dir, commit } = repo(t);
  const sha = commit("work", { email: addr("noreply", "acme.example") });
  const r = checkHistory({ repo: dir, range: "HEAD", patterns, isAllowedEmail: allowedEmailTest() });
  assert.deepEqual(r.problems, [`${sha.slice(0, 7)}: author e-mail domain matches denylist pattern #2`, `${sha.slice(0, 7)}: committer e-mail domain matches denylist pattern #2`]);

  const widened = commit("work", { email: addr("person", "acme.example") });
  const w = checkHistory({ repo: dir, range: "HEAD", patterns, isAllowedEmail: allowedEmailTest("@acme\\.example$") });
  assert.deepEqual(w.problems, [`${widened.slice(0, 7)}: author e-mail domain matches denylist pattern #2`, `${widened.slice(0, 7)}: committer e-mail domain matches denylist pattern #2`], "widening allows the address; the domain scan still applies");
});

test("checkHistory: a second @ in an address and a unit separator in a message cannot hide text from the scan", (t) => {
  const { dir, commit } = repo(t);
  const twoAts = commit("work", { email: `${addr("noreply", "x")}@acme.example` });
  const r = checkHistory({ repo: dir, range: "HEAD", patterns, isAllowedEmail: allowedEmailTest() });
  assert.deepEqual(r.problems, [
    `${twoAts.slice(0, 7)}: author e-mail domain matches denylist pattern #1`,
    `${twoAts.slice(0, 7)}: author e-mail domain matches denylist pattern #2`,
    `${twoAts.slice(0, 7)}: committer e-mail domain matches denylist pattern #1`,
    `${twoAts.slice(0, 7)}: committer e-mail domain matches denylist pattern #2`,
  ], "everything after the first @ is scanned, and it looks like an address itself");
  const cut = commit("work\x1fmention Acme after a unit separator");
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD", patterns, isAllowedEmail: allowedEmailTest() }).problems, [`${cut.slice(0, 7)}: message line 1 matches denylist pattern #2`]);
});

test("checkHistory: in a message, an allowed address is masked to its domain, so the domain is still scanned", (t) => {
  const { dir, commit } = repo(t);
  commit(`work\n\nCo-Authored-By: Bot <${addr("noreply", "anthropic.com")}>`);
  const leak = commit(`work\n\nCo-Authored-By: Someone <${addr("someone", "company.example")}>`);
  const hidden = commit(`work\n\nCo-Authored-By: Bot <${addr("noreply", "acme.example")}>`);
  const isAllowedEmail = allowedEmailTest();
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD~2", patterns, isAllowedEmail }).problems, []);
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD~1", patterns, isAllowedEmail }).problems, [`${leak.slice(0, 7)}: message line 3 matches denylist pattern #1`]);
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD", patterns, isAllowedEmail }).problems, [`${hidden.slice(0, 7)}: message line 3 matches denylist pattern #2`], "the no-reply local part is allowed, the domain still names the client");
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD~1", patterns, isAllowedEmail: allowedEmailTest("@company\\.example$") }).problems, [], "a widened rule masks that address's local part too");
});

test("checkHistory: an unreachable range is one clear error that points at the manual run", (t) => {
  const { dir, commit } = repo(t);
  commit("init");
  assert.throws(() => checkHistory({ repo: dir, range: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..HEAD", patterns, isAllowedEmail: allowedEmailTest() }), /cannot list the commits of "deadbeef[0-9a-f]+\.\.HEAD": .*run the workflow manually/);
});
