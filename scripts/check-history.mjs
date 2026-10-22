#!/usr/bin/env node
// Commit messages and e-mail addresses must stay publishable. The tree guard (test/publish-guard.test.mjs)
// cannot see them, so CI runs this over the commits of each push or pull request:
// - messages must match no denylist pattern (scripts/denylist.mjs);
// - author and committer e-mail addresses must be allowed: GitHub noreply addresses, GitHub's own bot senders and
//   generic no-reply senders by default, plus whatever MC_ALLOWED_EMAILS (a regular expression) adds. It widens
//   the rule, never replaces it;
// - the domain of every address, allowed or not, is scanned against the denylist as well, so a name hidden in a
//   domain (an author at a client's no-reply address, say) still fails. This also applies to an address that
//   MC_ALLOWED_EMAILS allows. Inside a message an allowed address is masked to `<allowed>@domain` before the scan:
//   the domain is checked; the local part (a GitHub login or "noreply") is deliberately not, because a login is a
//   public GitHub identity, and that holds for a co-author's login as much as for the publishing account's.
// Author and committer names are not scanned: they are the publishing GitHub account, public by construction.
// Usage: node scripts/check-history.mjs [<rev-range>]     default: the last commit (HEAD)
// A range with an all-zeros or empty left side (a repository's first push; a manual or scheduled run) checks every
// commit reachable from the right side, which on a new repository is its whole history.
// Matches are reported by pattern number, never by text, because CI logs can be public.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDenylist, scan } from "./denylist.mjs";

export const NOREPLY = /@users\.noreply\.github\.com$|^(noreply|support|actions)@github\.com$|^no-?reply@/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Everything after the first @, so a second @ (git validates nothing) lands in the scanned part. */
const domainOf = (email) => {
  const at = email.indexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
};

/** The allowed-e-mail test: NOREPLY, widened by `extra` (a regular expression source) when given. */
export function allowedEmailTest(extra = null) {
  let more = null;
  if (extra) {
    try {
      more = new RegExp(extra, "i");
    } catch {
      throw new Error("MC_ALLOWED_EMAILS is not a valid regular expression"); // never echo it: the variable is not masked in logs
    }
  }
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
  const MAX_OUTPUT = 256 * 1024 * 1024; // a whole history's messages in one call; Node's default cap is 1 MB
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_OUTPUT });
  let log;
  try {
    // One call for every commit: records separated by NUL, fields by the unit separator. No signature output in front.
    log = git("log", "-z", "--no-show-signature", "--format=%H%x1f%ae%x1f%ce%x1f%B", ...revArgsFor(range));
  } catch (e) {
    if (e.code === "ENOBUFS") throw new Error(`the commit messages of "${range}" exceed ${MAX_OUTPUT / 1024 / 1024} MB; check a narrower range`);
    const reason = String(e.stderr ?? e.message).split("\n")[0];
    throw new Error(`cannot list the commits of "${range}": ${reason}. After a force-push the old tip is unreachable; run the workflow manually, which checks the whole history (locally: pass ..HEAD).`);
  }
  const records = log.split("\0").filter((r) => r.trim());
  const problems = [];
  for (const record of records) {
    // A unit separator inside a message must not cut the message short, so the body is everything after field three.
    const [sha, authorEmail = "", committerEmail = "", ...rest] = record.split("\x1f");
    const body = rest.join("\x1f");
    const short = sha.slice(0, 7);
    for (const [who, email] of [["author", authorEmail], ["committer", committerEmail]]) {
      if (!isAllowedEmail(email)) problems.push(`${short}: ${who} e-mail is not an allowed (noreply) address`);
      for (const h of scan(domainOf(email), patterns)) problems.push(`${short}: ${who} e-mail domain matches denylist pattern #${h.pattern}`);
    }
    const message = body.replace(EMAIL_RE, (m) => (isAllowedEmail(m) ? `<allowed>@${domainOf(m)}` : m));
    for (const h of scan(message, patterns)) problems.push(`${short}: message line ${h.line} matches denylist pattern #${h.pattern}`);
  }
  return { commits: records.length, problems };
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
