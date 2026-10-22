import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedEmailTest, checkHistory, revArgsFor, NOREPLY } from "../scripts/check-history.mjs";

// Addresses are assembled here, not written out, so this file itself passes the publish guard's e-mail pattern.
const addr = (local, domain) => `${local}@${domain}`;
const NOREPLY_ADDRESS = addr("98765+someone", "users.noreply.github.com");
const COMPANY = addr("person", "company.example");
const patterns = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i, /acme/i];

/** A throwaway repository with no user or system git config, so nothing signs or rewrites commits. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "mc-history-"));
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

test("allowedEmailTest: GitHub noreply and generic no-reply senders pass; MC_ALLOWED_EMAILS widens, never replaces", () => {
  const plain = allowedEmailTest();
  assert.ok(plain(NOREPLY_ADDRESS));
  assert.ok(plain(addr("noreply", "github.com")));
  assert.ok(plain(addr("support", "github.com")), "GitHub's own domain: bots sign off with it");
  assert.ok(!plain(addr("someone", "github.com.example")), "the domain match is anchored");
  assert.ok(plain(addr("no-reply", "anthropic.com")));
  assert.ok(!plain(COMPANY));
  const widened = allowedEmailTest("@company\\.example$");
  assert.ok(widened(COMPANY));
  assert.ok(widened(NOREPLY_ADDRESS), "the default stays allowed");
  assert.ok(!widened(addr("someone", "elsewhere.example")));
  assert.ok(NOREPLY.test(addr("NOREPLY", "example.org")), "case-insensitive");
});

test("checkHistory: clean commits pass; a non-allowed e-mail and a denylisted word in a message are problems", () => {
  const { dir, commit } = repo();
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

test("checkHistory: an allowed address in a trailer is masked before the scan; another address is not", () => {
  const { dir, commit } = repo();
  commit(`work\n\nCo-Authored-By: Bot <${addr("noreply", "anthropic.com")}>`);
  const leak = commit(`work\n\nCo-Authored-By: Someone <${addr("someone", "company.example")}>`);
  const isAllowedEmail = allowedEmailTest();
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD~1", patterns, isAllowedEmail }).problems, []);
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD", patterns, isAllowedEmail }).problems, [`${leak.slice(0, 7)}: message line 3 matches denylist pattern #1`]);
  assert.deepEqual(checkHistory({ repo: dir, range: "HEAD", patterns, isAllowedEmail: allowedEmailTest("@company\\.example$") }).problems, [], "a widened rule masks that address too");
});

test("checkHistory: an unreachable range is one clear error, not a stack trace", () => {
  const { dir, commit } = repo();
  commit("init");
  assert.throws(() => checkHistory({ repo: dir, range: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..HEAD", patterns, isAllowedEmail: allowedEmailTest() }), /cannot list the commits of "deadbeef[0-9a-f]+\.\.HEAD": .*force-push/);
});
