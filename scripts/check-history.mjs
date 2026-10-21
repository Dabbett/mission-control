#!/usr/bin/env node
// Commit messages and e-mail addresses must stay publishable. The tree guard (test/publish-guard.test.mjs)
// cannot see them, so CI runs this over the commits of each push or pull request:
// - messages must match no denylist pattern (scripts/denylist.mjs);
// - author and committer e-mail addresses must be GitHub noreply addresses, so no personal or company address
//   lands in a public history (MC_ALLOWED_EMAILS, a regular expression, widens that when a project needs it).
// Author and committer names are not scanned: they are the publishing GitHub account, public by construction.
// Usage: node scripts/check-history.mjs [<rev-range>]     default: the last commit (HEAD)
// A range whose left side is all zeros (GitHub's "before" on a repository's first push) checks every commit
// reachable from the right side, which on a new repository is its whole history.
// An e-mail address inside a message (a Co-Authored-By trailer, say) is fine when it is itself an allowed address.
// Matches are reported by pattern number, never by text, because CI logs can be public.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDenylist, scan } from "./denylist.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

const arg = process.argv[2] ?? "HEAD";
const fresh = arg.match(/^0{40}\.\.(.+)$/);
const revArgs = fresh ? [fresh[1]] : arg === "HEAD" ? ["-1", "HEAD"] : [arg];
const allowedEmail = process.env.MC_ALLOWED_EMAILS ? new RegExp(process.env.MC_ALLOWED_EMAILS, "i") : /@users\.noreply\.github\.com$|^noreply@github\.com$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const { patterns, privateSource } = loadDenylist({ root });
if (!privateSource && process.env.CI) {
  console.error("check-history: no private denylist. Set the MC_DENYLIST repository secret (one pattern per line).");
  process.exit(1);
}

const shas = git("rev-list", ...revArgs).split("\n").filter(Boolean);
const problems = [];
for (const sha of shas) {
  const short = sha.slice(0, 7);
  const [authorEmail, committerEmail] = git("show", "-s", "--format=%ae%n%ce", sha).split("\n");
  for (const [who, email] of [["author", authorEmail], ["committer", committerEmail]]) {
    if (!allowedEmail.test(email)) problems.push(`${short}: ${who} e-mail is not a GitHub noreply address`);
  }
  const message = git("show", "-s", "--format=%B", sha).replace(EMAIL_RE, (m) => (allowedEmail.test(m) ? "<allowed e-mail>" : m));
  for (const h of scan(message, patterns)) problems.push(`${short}: message line ${h.line} matches denylist pattern #${h.pattern}`);
}

if (problems.length) {
  for (const p of problems) console.error(`check-history: ${p}`);
  console.error(`check-history: ${problems.length} problem(s) in ${shas.length} commit(s). Reword the message, or set git user.email to your GitHub noreply address.`);
  process.exit(1);
}
console.log(`check-history: ${shas.length} commit(s) clean against ${patterns.length} pattern(s)${privateSource ? "" : " (tree patterns only; no private denylist)"}`);
