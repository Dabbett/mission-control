// The tree must stay publishable: no client, partner or personal identifiers anywhere, synthetic fixtures only,
// and no project config but the example. These are mechanisms, not reminders; CI runs them on every push.
// The denylist comes in two parts (scripts/denylist.mjs): generic patterns in the tree, and a private list of
// names that is kept out of the tree on purpose. Matches are reported by pattern number, never by pattern text.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { root } from "./helpers.mjs";
import { loadDenylist, scan, TREE_DENYLIST } from "../scripts/denylist.mjs";

const FIXTURES = join("test", "fixtures");
const EXAMPLE_ORG = "example-org";
const inCI = Boolean(process.env.CI);

/**
 * Tracked plus untracked-but-not-ignored files. Without git (a `git archive` export) every file present was tracked,
 * including anything force-added past .gitignore, so the fallback walk skips nothing but build and OS debris.
 */
function repoFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .filter((f) => statSync(join(root, f), { throwIfNoEntry: false })?.isFile());
  } catch {
    const out = [];
    (function walk(dir) {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".git" || name === ".DS_Store") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(relative(root, p));
      }
    })(root);
    return out;
  }
}

function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

test("publish guard: a private denylist is configured (required in CI, advisory locally)", (t) => {
  const { privateSource } = loadDenylist({ root });
  if (privateSource) return;
  if (inCI) assert.fail("no private denylist: set the MC_DENYLIST repository secret (one pattern per line)");
  t.skip("no private denylist at ~/.config/mission-control/denylist.txt; only the tree's generic patterns were checked");
});

test("publish guard: no tracked file matches a denylist pattern", () => {
  const { patterns, tree } = loadDenylist({ root });
  assert.ok(tree.length >= 2, "the tree denylist holds the generic patterns");
  const hits = [];
  for (const file of repoFiles()) {
    if (file === TREE_DENYLIST) continue;
    const text = readFileSync(join(root, file), "utf8");
    if (text.includes("\0")) continue; // binary
    for (const h of scan(text, patterns)) hits.push(`${file}:${h.line}: pattern #${h.pattern}`);
  }
  assert.deepEqual(hits, [], `denylisted terms found (pattern numbers refer to .github/denylist.txt, then the private list):\n${hits.join("\n")}`);
});

test("publish guard: every fixture is synthetic (example org, example URLs, generic titles)", () => {
  const files = readdirSync(join(root, FIXTURES)).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 1, "there is at least one fixture");
  for (const f of files) {
    const fixture = JSON.parse(readFileSync(join(root, FIXTURES, f), "utf8"));
    assert.equal(fixture.project?.org, EXAMPLE_ORG, `${f}: project.org`);
    assert.equal(fixture.project?.key, "example", `${f}: project.key`);
    const bad = strings(fixture).filter((s) => s.includes("github.com/") && !s.startsWith(`https://github.com/${EXAMPLE_ORG}/`) && !s.startsWith(`https://github.com/orgs/${EXAMPLE_ORG}/`));
    assert.deepEqual(bad, [], `${f}: URLs outside ${EXAMPLE_ORG}`);
    const titles = strings(fixture.nodes.map((n) => n.content?.title ?? null));
    const odd = titles.filter((t) => !/^(\[On hold\] )?(Item|PR) \d+$/.test(t));
    assert.deepEqual(odd, [], `${f}: titles that are not generic`);
  }
});

test("publish guard: projects/ tracks only example.json", () => {
  const tracked = repoFiles().filter((f) => f.startsWith("projects/"));
  assert.deepEqual(tracked, ["projects/example.json"]);
});
