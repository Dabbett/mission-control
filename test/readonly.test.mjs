import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadOnly, definitions } from "../src/readonly.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = readFileSync(join(root, "src", "board.graphql"), "utf8");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("the committed document holds exactly one operation and it is a query", () => {
  const ops = definitions(DOC).filter((d) => d.kind !== "fragment");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "query");
  assert.match(ops[0].head, /^query Board\(/);
  assert.equal(assertReadOnly(DOC), true);
});

test("a write operation is refused", () => {
  const write = "mu" + "tation M { x }";
  assert.throws(() => assertReadOnly(write), /not a query/);
  assert.throws(() => assertReadOnly("subscription S { x }"), /not a query/);
});

test("two operations are refused, even if both are queries", () => {
  assert.throws(() => assertReadOnly("query A { x } query B { y }"), /exactly one operation/);
  assert.throws(() => assertReadOnly("query A { x } " + "mu" + "tation B { y }"), /exactly one operation/);
});

test("an anonymous query with fragments is accepted", () => {
  assert.equal(assertReadOnly("# comment\n{ a { ...F } }\nfragment F on T { b }"), true);
});

test("comments cannot hide a second operation", () => {
  const sneaky = "query A { x } # mu" + "tation hidden { y }";
  assert.equal(assertReadOnly(sneaky), true);
  assert.equal(definitions(sneaky).length, 1);
});

test("no write keyword appears anywhere under src/", () => {
  const forbidden = "mu" + "tation";
  for (const file of walk(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(forbidden), `${file} contains the word ${forbidden}`);
  }
});

test("github.mjs exposes exactly one function and it takes no document", async () => {
  const mod = await import("../src/github.mjs");
  assert.deepEqual(Object.keys(mod), ["fetchBoard"]);
  assert.equal(typeof mod.fetchBoard, "function");
  // The body is always built from the module-level DOCUMENT; no parameter can supply a document.
  assert.match(mod.fetchBoard.toString(), /query: DOCUMENT/);
  assert.doesNotMatch(mod.fetchBoard.toString(), /deps\.(query|document|doc)\b/);
});

test("fetchBoard sends only the committed document to the GraphQL endpoint", async () => {
  const { fetchBoard } = await import("../src/github.mjs");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
          organization: { projectV2: { title: "T", url: "https://github.com/orgs/o/projects/1", items: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
        },
      }),
    };
  };
  const out = await fetchBoard({ org: "o", projectNumber: 1 }, { fetch: fetchImpl, getToken: async () => "tok" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["query", "variables"]);
  assert.equal(body.query, DOC);
  assert.deepEqual(body.variables, { org: "o", number: 1, after: null });
  assert.equal(out.nodes.length, 0);
  assert.equal(out.title, "T");
});

test("fetchBoard treats a GraphQL errors array as a failed fetch", async () => {
  const { fetchBoard } = await import("../src/github.mjs");
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: null, errors: [{ message: "boom" }] }) });
  await assert.rejects(fetchBoard({ org: "o", projectNumber: 1 }, { fetch: fetchImpl, getToken: async () => "tok" }), /GraphQL errors: boom/);
});

test("the committed document has no string literal that could fool the brace scanner", () => {
  assert.doesNotMatch(DOC, /"[^"\n]*[#{}][^"\n]*"/);
});

test("fetchBoard turns a timeout into a plain message", async () => {
  const { fetchBoard } = await import("../src/github.mjs");
  const fetchImpl = async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  await assert.rejects(fetchBoard({ org: "o", projectNumber: 1 }, { fetch: fetchImpl, getToken: async () => "tok" }), /did not answer within 20 s/);
});

test("fetchBoard turns a timeout during the body read, and a non-JSON body, into plain messages", async () => {
  const { fetchBoard } = await import("../src/github.mjs");
  const stall = async () => ({ ok: true, status: 200, json: async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); } });
  await assert.rejects(fetchBoard({ org: "o", projectNumber: 1 }, { fetch: stall, getToken: async () => "tok" }), /did not answer within 20 s/);
  const html = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  await assert.rejects(fetchBoard({ org: "o", projectNumber: 1 }, { fetch: html, getToken: async () => "tok" }), /not JSON/);
  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchBoard({ org: "o", projectNumber: 1 }, { fetch: down, getToken: async () => "tok" }), /GitHub returned HTTP 503/);
});

test("fetchBoard keeps going on per-item FORBIDDEN or NOT_FOUND errors and reports them as partial", async () => {
  const { fetchBoard } = await import("../src/github.mjs");
  const page = (errors) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        rateLimit: { cost: 1, remaining: 1, resetAt: "x" },
        organization: { projectV2: { title: "T", url: "u", items: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ type: "ISSUE", content: { __typename: "Issue", number: 1, blockedBy: { totalCount: 1, nodes: [null] } } }] } } },
      },
      errors,
    }),
  });
  const itemError = { type: "FORBIDDEN", path: ["organization", "projectV2", "items", "nodes", 0, "content", "blockedBy", "nodes", 0], message: "Resource not accessible by integration" };
  const out = await fetchBoard({ org: "o", projectNumber: 1 }, { fetch: page([itemError]), getToken: async () => "tok" });
  assert.equal(out.nodes.length, 1);
  assert.deepEqual(out.partial, ["FORBIDDEN at 0.content.blockedBy.nodes.0: Resource not accessible by integration"]);
  const topLevel = { type: "FORBIDDEN", path: ["organization", "projectV2"], message: "no" };
  await assert.rejects(fetchBoard({ org: "o", projectNumber: 1 }, { fetch: page([topLevel]), getToken: async () => "tok" }), /GraphQL errors: no/);
  const otherType = { type: "RATE_LIMITED", path: ["organization", "projectV2", "items", "nodes", 0], message: "slow down" };
  await assert.rejects(fetchBoard({ org: "o", projectNumber: 1 }, { fetch: page([otherType]), getToken: async () => "tok" }), /slow down/);
});

test("fetchBoard pages until hasNextPage is false", async () => {
  const { fetchBoard } = await import("../src/github.mjs");
  let n = 0;
  const fetchImpl = async (url, init) => {
    const after = JSON.parse(init.body).variables.after;
    n++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          rateLimit: { cost: 1, remaining: 1, resetAt: "x" },
          organization: {
            projectV2: {
              title: "T", url: "u",
              items: { totalCount: 2, pageInfo: { hasNextPage: after === null, endCursor: "c1" }, nodes: [{ type: "ISSUE", content: { __typename: "Issue", number: after === null ? 1 : 2 } }] },
            },
          },
        },
      }),
    };
  };
  const out = await fetchBoard({ org: "o", projectNumber: 1 }, { fetch: fetchImpl, getToken: async () => "tok" });
  assert.equal(n, 2);
  assert.deepEqual(out.nodes.map((x) => x.content.number), [1, 2]);
});
