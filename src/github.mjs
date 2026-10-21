// The only path to GitHub. One document, one function, read-only by construction and by test.
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertReadOnly } from "./readonly.mjs";

const DOCUMENT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "board.graphql"), "utf8");
assertReadOnly(DOCUMENT);

const ENDPOINT = "https://api.github.com/graphql";
const MAX_PAGES = 20;
const TIMEOUT_MS = 20_000;
const ITEM_PATH = ["organization", "projectV2", "items", "nodes"];

/** Errors GitHub attaches to one item (a blocker in a repo the token can't read) leave that node null and the
 *  rest of the data intact; the model then fails closed on the null. Anything else is a failed fetch. */
function splitErrors(errors) {
  const partial = [];
  const fatal = [];
  for (const e of errors) {
    const path = Array.isArray(e.path) ? e.path : [];
    const underItems = ITEM_PATH.every((seg, i) => path[i] === seg) && path.length > ITEM_PATH.length;
    if (underItems && (e.type === "FORBIDDEN" || e.type === "NOT_FOUND")) partial.push(`${e.type} at ${path.slice(ITEM_PATH.length).join(".")}: ${e.message ?? "unknown error"}`);
    else fatal.push(e.message ?? "unknown error");
  }
  return { partial, fatal };
}

let cachedToken = null;

function defaultGetToken() {
  if (process.env.MISSION_CONTROL_TOKEN) return Promise.resolve(process.env.MISSION_CONTROL_TOKEN);
  if (cachedToken) return Promise.resolve(cachedToken);
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { timeout: 10_000 }, (err, stdout) => {
      const token = (stdout || "").trim();
      if (err || !token) {
        reject(new Error("gh is not logged in. Run `gh auth login`, or set MISSION_CONTROL_TOKEN to a read-only token."));
        return;
      }
      cachedToken = token;
      resolve(token);
    });
  });
}

/**
 * Fetch every item of one GitHub Project with the committed query.
 * @param {{org: string, projectNumber: number}} project
 * @param {{fetch?: typeof fetch, getToken?: () => Promise<string>}} deps  test seams only
 */
export async function fetchBoard(project, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const getToken = deps.getToken ?? defaultGetToken;
  const token = await getToken();

  const nodes = [];
  let after = null;
  let rateLimit = null;
  let title = null;
  let url = null;
  let pages = 0;
  const partial = [];
  const signal = AbortSignal.timeout(TIMEOUT_MS); // one deadline for the whole board, however many pages

  do {
    let res;
    let json;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "mission-control",
        },
        body: JSON.stringify({ query: DOCUMENT, variables: { org: project.org, number: project.projectNumber, after } }),
        signal,
      });
      if (res.status === 401) {
        cachedToken = null;
        throw new Error("GitHub rejected the token (401). Run `gh auth login` again.");
      }
      if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
      json = await res.json();
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error(`GitHub did not answer within ${TIMEOUT_MS / 1000} s`);
      if (e?.name === "SyntaxError") throw new Error("GitHub returned a body that is not JSON");
      if (e instanceof Error && /^GitHub /.test(e.message)) throw e;
      throw new Error(`GitHub unreachable: ${e?.message ?? e}`);
    }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      const split = splitErrors(json.errors);
      if (split.fatal.length) throw new Error("GraphQL errors: " + split.fatal.join("; "));
      partial.push(...split.partial);
    }
    const p = json.data?.organization?.projectV2;
    if (!p) throw new Error(`Project ${project.org}/${project.projectNumber} not found or not readable`);
    title = p.title;
    url = p.url;
    rateLimit = json.data.rateLimit ?? rateLimit;
    nodes.push(...(p.items?.nodes ?? []));
    after = p.items?.pageInfo?.hasNextPage ? p.items.pageInfo.endCursor : null;
    pages++;
    if (after && pages >= MAX_PAGES) throw new Error("Project has more pages than this tool will read");
  } while (after);

  return { title, url, nodes, rateLimit, partial, fetchedAt: new Date().toISOString() };
}
