#!/usr/bin/env node
// Commit messages and e-mail addresses must stay publishable. The tree guard (test/publish-guard.test.mjs)
// cannot see them, so CI runs this over the commits of each push or pull request:
// - messages must match no denylist pattern (scripts/denylist.mjs);
// - author and committer e-mail addresses must be allowed: GitHub noreply addresses and generic no-reply senders
//   by default, plus whatever MC_ALLOWED_EMAILS (a regular expression) adds. It widens the rule, never replaces it.
// Author and committer names are not scanned: they are the publishing GitHub account, public by construction.
// Usage: node scripts/check-history.mjs [<rev-range>]     default: the last commit (HEAD)
// A range with an all-zeros or empty left side (a repository's first push; a manual or scheduled run) checks every
// commit reachable from the right side, which on a new repository is its whole history.
// Matches are reported by pattern number, never by text, because CI logs can be public.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDenylist, scan } from "./denylist.mjs";

export const NOREPLY = /@users\.noreply\.github\.com$|^no-?reply@/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The allowed-e-mail test: NOREPLY, widened by `extra` (a regular expression source) when given. */
export function allowedEmailTest(extra = null) {
  const more = extra ? new RegExp(extra, "i") : null;
  return (email) => NOREPLY.test(email) || (more !== null && more.test(email));
}

/** `git rev-list` arguments for a range argument. */
export function revArgsFor(arg = "HEAD") {
  const whole = arg.match(/^(?:0{40})?\.\.(.+)$/);
  if (whole) return [whole[1]];
  return arg === "HEAD" ? ["-1", "HEAD"] : [arg];
}

/**
 * @param {{ repo: string, range?: string, patterns: RegExp[], isAllowedEmail: (email: string) => boolean }} opts
 * @returns {{ commits: number, problems: string[] }}
 */
export function checkHistory({ repo, range = "HEAD", patterns, isAllowedEmail }) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let shas;
  try {
    shas = git("rev-list", ...revArgsFor(range)).split("\n").filter(Boolean);
  } catch (e) {
    const reason = String(e.stderr ?? e.message).split("\n")[0];
    throw new Error(`cannot list the commits of "${range}": ${reason}. After a force-push the old tip may be unreachable; pass an explicit range.`);
  }
  const problems = [];
  for (const sha of shas) {
    const short = sha.slice(0, 7);
    const [authorEmail, committerEmail] = git("show", "-s", "--format=%ae%n%ce", sha).split("\n");
    for (const [who, email] of [["author", authorEmail], ["committer", committerEmail]]) {
      if (!isAllowedEmail(email)) problems.push(`${short}: ${who} e-mail is not an allowed (noreply) address`);
    }
    // An allowed address inside the message (a Co-Authored-By trailer) is masked whole before the scan: its local
    // part is a GitHub login or "noreply", public by construction, so it is not a leak.
    const message = git("show", "-s", "--format=%B", sha).replace(EMAIL_RE, (m) => (isAllowedEmail(m) ? "<allowed e-mail>" : m));
    for (const h of scan(message, patterns)) problems.push(`${short}: message line ${h.line} matches denylist pattern #${h.pattern}`);
  }
  return { commits: shas.length, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { patterns, privateSource } = loadDenylist({ root });
  if (!privateSource && process.env.CI) {
    console.error("check-history: no private denylist. Set the MC_DENYLIST repository secret (one pattern per line).");
    process.exit(1);
  }
  let result;
  try {
    result = checkHistory({ repo: root, range: process.argv[2] ?? "HEAD", patterns, isAllowedEmail: allowedEmailTest(process.env.MC_ALLOWED_EMAILS || null) });
  } catch (e) {
    console.error(`check-history: ${e.message}`);
    process.exit(1);
  }
  if (result.problems.length) {
    for (const p of result.problems) console.error(`check-history: ${p}`);
    console.error(`check-history: ${result.problems.length} problem(s) in ${result.commits} commit(s). Reword the message, or set git user.email to your GitHub noreply address.`);
    process.exit(1);
  }
  console.log(`check-history: ${result.commits} commit(s) clean against ${patterns.length} pattern(s)${privateSource ? "" : " (tree patterns only; no private denylist)"}`);
}
