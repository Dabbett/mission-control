import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./helpers.mjs";
import { loadDenylist, privateDenylistPath, scan } from "../scripts/denylist.mjs";

test("denylist: the tree list always loads; the private list comes from MC_DENYLIST, else the config file, else nowhere", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-denylist-"));
  const none = loadDenylist({ root, env: {}, home });
  assert.ok(none.tree.length >= 2);
  assert.deepEqual(none.private, []);
  assert.equal(none.privateSource, null);
  assert.equal(none.patterns.length, none.tree.length);

  const file = privateDenylistPath({ env: {}, home });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "# names\nacme\n\n\\bglobex\\b\n");
  const fromFile = loadDenylist({ root, env: {}, home });
  assert.equal(fromFile.privateSource, file);
  assert.deepEqual(fromFile.private.map((r) => r.source), ["acme", "\\bglobex\\b"]);
  assert.equal(fromFile.patterns.length, fromFile.tree.length + 2);

  const fromEnv = loadDenylist({ root, env: { MC_DENYLIST: "initech\n" }, home });
  assert.equal(fromEnv.privateSource, "MC_DENYLIST", "the variable wins over the file");
  assert.deepEqual(fromEnv.private.map((r) => r.source), ["initech"]);
  assert.equal(loadDenylist({ root, env: { MC_DENYLIST: "  \n" }, home }).privateSource, file, "a blank variable does not count");
  assert.ok(fromEnv.private[0].test("INITECH"), "patterns are case-insensitive");
});

test("denylist: a bad private pattern is reported by line number only, never by its text", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-denylist-"));
  assert.throws(
    () => loadDenylist({ root, env: { MC_DENYLIST: "# comment\nfine\n(secret-name\n" }, home }),
    (e) => e.message === "MC_DENYLIST: line 3 is not a valid regular expression",
  );
  const file = privateDenylistPath({ env: {}, home });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "[oops\n");
  assert.throws(() => loadDenylist({ root, env: {}, home }), (e) => e.message === `${file}: line 1 is not a valid regular expression`);
});

test("denylist: scan reports (line, pattern number) pairs, not the matched text", () => {
  const patterns = [/acme/i, /\bglobex\b/i];
  assert.deepEqual(scan("clean\nAcme Corp\nglobexx\nboth acme and globex", patterns), [
    { line: 2, pattern: 1 },
    { line: 4, pattern: 1 },
    { line: 4, pattern: 2 },
  ]);
  assert.deepEqual(scan("", patterns), []);
});
