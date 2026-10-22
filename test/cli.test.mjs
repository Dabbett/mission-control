import test from "node:test";
import assert from "node:assert/strict";
import { flagReader } from "../src/cli.mjs";

const spec = { values: ["--port", "--out"], switches: ["--synthetic"] };

test("flagReader: declared value flags and switches are read; absent ones fall back", () => {
  const flag = flagReader(["--port", "7200", "--synthetic"], spec);
  assert.equal(flag("--port"), "7200");
  assert.equal(flag("--out", "/tmp/default"), "/tmp/default");
  assert.equal(flag("--out"), null);
  assert.equal(flag.has("--synthetic"), true);
  assert.equal(flag.has("--port"), true);
  assert.equal(flagReader([], spec).has("--synthetic"), false);
});

test("flagReader: a value flag without a value, or followed by another flag, is an error", () => {
  assert.throws(() => flagReader(["--port"], spec), /--port needs a value/);
  assert.throws(() => flagReader(["--out", "--synthetic"], spec), /--out needs a value/);
});

test("flagReader: unknown flags, --name=value and stray words are errors that list the flags", () => {
  assert.throws(() => flagReader(["--bogus"], spec), /unknown argument --bogus; flags: --port <value>, --out <value>, --synthetic/);
  assert.throws(() => flagReader(["--port=7200"], spec), /unknown argument --port=7200/);
  assert.throws(() => flagReader(["--out", "/tmp/x", "extra"], spec), /unknown argument extra/);
});

test("flagReader: a flag given twice is an error, never a silent first-wins", () => {
  assert.throws(() => flagReader(["--port", "1", "--port", "2"], spec), /--port given twice/);
  assert.throws(() => flagReader(["--synthetic", "--synthetic"], spec), /--synthetic given twice/);
});

test("flagReader: asking for an undeclared flag is a programming error, not a quiet null", () => {
  const flag = flagReader([], spec);
  assert.throws(() => flag("--nope"), /not a declared value flag/);
  assert.throws(() => flag.has("--nope"), /not a declared flag/);
});
