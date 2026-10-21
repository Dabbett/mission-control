// The publish denylist, in two parts:
// - .github/denylist.txt in the tree: generic patterns (machine paths, e-mail addresses), safe to publish.
// - the private list: the names of clients, partners and people that the public tree must never contain. Listing
//   them in the tree would publish them, so they live in the MC_DENYLIST variable (an Actions secret in CI, one
//   pattern per line) or in ${XDG_CONFIG_HOME:-~/.config}/mission-control/denylist.txt.
// Matches are reported by pattern number, never by pattern text, because CI logs can be public.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "../src/config.mjs";

export const TREE_DENYLIST = join(".github", "denylist.txt");

/** One regex per non-blank, non-comment line. For the private list the error names the line number only: V8 puts the pattern text into a syntax error's message, and CI logs can be public. */
function parse(text, source, { redact }) {
  const patterns = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      patterns.push(new RegExp(line, "i"));
    } catch (e) {
      throw new Error(redact ? `${source}: line ${i + 1} is not a valid regular expression` : `${source}: line ${i + 1} is not a valid regular expression (${e.message})`);
    }
  });
  return patterns;
}

export function privateDenylistPath({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_CONFIG_HOME ? resolve(expandHome(env.XDG_CONFIG_HOME, home)) : join(home, ".config");
  return join(base, "mission-control", "denylist.txt");
}

/**
 * @returns {{ patterns: RegExp[], tree: RegExp[], private: RegExp[], privateSource: string | null }}
 * `privateSource` is "MC_DENYLIST", the file path, or null when no private list was found.
 */
export function loadDenylist({ root, env = process.env, home = homedir() }) {
  const tree = parse(readFileSync(join(root, TREE_DENYLIST), "utf8"), TREE_DENYLIST, { redact: false });
  let priv = [];
  let privateSource = null;
  if (env.MC_DENYLIST && env.MC_DENYLIST.trim()) {
    priv = parse(env.MC_DENYLIST, "MC_DENYLIST", { redact: true });
    privateSource = "MC_DENYLIST";
  } else {
    const path = privateDenylistPath({ env, home });
    if (existsSync(path)) {
      priv = parse(readFileSync(path, "utf8"), path, { redact: true });
      privateSource = path;
    }
  }
  return { patterns: [...tree, ...priv], tree, private: priv, privateSource };
}

/** Every (line, pattern index) pair in `text` that matches; the matched text itself is never returned. */
export function scan(text, patterns) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    patterns.forEach((re, k) => {
      if (re.test(line)) hits.push({ line: i + 1, pattern: k + 1 });
    });
  });
  return hits;
}
