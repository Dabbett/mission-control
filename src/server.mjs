// Local server: 127.0.0.1 only, three static files, one read endpoint, one opt-in start endpoint.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { normalize, buildSkeleton, LEAF } from "./model.mjs";
import { copyLine, modelFor } from "./prompt.mjs";
import { claimStatusName } from "./status.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/app.css", { file: "app.css", type: "text/css; charset=utf-8" }],
]);

export const FORCE_MIN_SECONDS = 15;
export const BACKOFF_REMAINING = 500;
export const MAX_BODY_BYTES = 4096;
// Node's defaults (5 minutes for a request, 1 for its headers) let a client that never finishes its body park a socket.
// Node looks for overdue requests only every CHECK_EVERY_MS, so a stalled request lives at most the sum of the two.
export const REQUEST_TIMEOUT_MS = 15_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export const CHECK_EVERY_MS = 2_000;

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function send(res, status, type, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(obj));
}

/**
 * @param {object} deps
 * @param {Map<string, object>} deps.projects   validated projects by key
 * @param {(project) => Promise<object>} deps.fetchBoard   the one GitHub read
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @param {object} [deps.starter]   { start(project, number, opts) } from start.mjs; absent = Start disabled everywhere
 * @param {{ requestMs?: number, headersMs?: number, checkEveryMs?: number }} [deps.timeouts]   test seam, so a test
 *   can shorten all three
 */
export function createApp(deps) {
  const { projects, fetchBoard } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const starter = deps.starter ?? null;
  const nonce = randomBytes(16).toString("hex");
  // Not a secret: the page compares it with the one in its own HTML, so a page that outlived a restart (and holds a
  // dead nonce) can say so and offer a reload instead of failing every Start with "nonce refused".
  const runId = randomBytes(8).toString("hex");
  const states = new Map();

  function stateOf(project) {
    if (!states.has(project.key)) {
      states.set(project.key, { data: null, normalized: null, fetchedAt: 0, lastAttemptAt: 0, lastError: null, partial: [], inFlight: null, backoffUntil: 0 });
    }
    return states.get(project.key);
  }

  function backedOff(st) {
    return st.backoffUntil > now();
  }

  function intervalMs(st, project) {
    return project.refreshSeconds * 1000 * (backedOff(st) ? 2 : 1);
  }

  async function doFetch(project, st) {
    st.lastAttemptAt = now();
    try {
      const board = await fetchBoard(project);
      const normalized = normalize(board, project);
      st.normalized = normalized;
      st.partial = board.partial ?? [];
      st.data = buildSkeleton(normalized, project);
      // Ready leaves get their clipboard line and model here, so the page never builds a command itself.
      // A bad model label leaves the leaf without a command and says why, instead of failing the board.
      for (const layer of st.data.layers) {
        for (const group of layer.groups) {
          for (const part of group.parts) {
            for (const leaf of part.leaves) {
              if (leaf.state !== LEAF.ready || leaf.copy) continue;
              const { model, source, error } = modelFor(project, leaf);
              leaf.model = model;
              leaf.modelSource = source;
              if (error) leaf.commandError = error;
              else leaf.copy = copyLine(project, leaf);
            }
          }
        }
      }
      st.fetchedAt = now();
      st.lastError = null;
      const rl = board.rateLimit;
      if (rl && typeof rl.remaining === "number" && rl.remaining < BACKOFF_REMAINING) {
        const until = Date.parse(rl.resetAt);
        st.backoffUntil = Number.isFinite(until) ? until : now() + 60 * 60 * 1000;
      } else {
        st.backoffUntil = 0;
      }
    } catch (e) {
      st.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /** Serve from cache or fetch, with single-flight. `mode` is "scheduled", "forced" or "start".
   *  The interval counts from the last attempt, so a failing GitHub is not hammered on every request. */
  async function refresh(project, mode) {
    const st = stateOf(project);
    if (st.inFlight) {
      await st.inFlight; // whatever the mode, a fetch already under way is the freshest answer available
      return { st, refused: null };
    }
    const age = now() - Math.max(st.fetchedAt, st.lastAttemptAt);
    let shouldFetch = age >= intervalMs(st, project);
    let refused = null;
    if (!shouldFetch && (mode === "forced" || mode === "start")) {
      if (backedOff(st)) refused = "backoff";
      // age counts from the last attempt, so after a failure the cache can be older than the floor suggests
      else if (mode === "forced" && age < FORCE_MIN_SECONDS * 1000) refused = st.lastError ? "too-soon-after-failure" : "too-soon";
      else shouldFetch = true;
    }
    if (shouldFetch) {
      st.inFlight = doFetch(project, st).finally(() => (st.inFlight = null));
      await st.inFlight;
    }
    return { st, refused };
  }

  function boardResponse(project, st, refused) {
    const t = now();
    return {
      ...(st.data ?? {}),
      project: { key: project.key, title: project.title, repo: project.repo },
      runId,
      fetchedAt: st.fetchedAt ? new Date(st.fetchedAt).toISOString() : null,
      ageSeconds: st.fetchedAt ? Math.round((t - st.fetchedAt) / 1000) : null,
      refreshSeconds: intervalMs(st, project) / 1000,
      stale: Boolean(st.lastError && st.data),
      error: st.lastError,
      partial: st.partial,
      refused,
      backoff: { active: backedOff(st), until: st.backoffUntil ? new Date(st.backoffUntil).toISOString() : null },
      start: {
        enabled: Boolean(starter && project.start.enabled),
        started: starter ? starter.startedFor(project.key) : {},
        // With the opt-in claim, the page says what Start will write before anyone presses it.
        claim: project.start.claim === "dashboard" ? { status: claimStatusName(project) } : null,
      },
    };
  }

  function hostAllowed(req, port) {
    const host = (req.headers.host ?? "").toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (c) => {
        if (tooLarge) return;
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          reject(Object.assign(new Error("body too large"), { status: 413 }));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      // A request cut off mid-body (Node's request timeout answers 408 and destroys the socket) never ends: it
      // errors as aborted, then closes. Either way it settles as 408, so the log shows what the client saw.
      const cutOff = () => Object.assign(new Error("request not completed"), { status: 408 });
      req.on("error", (e) => reject(req.complete ? e : cutOff()));
      req.on("close", () => {
        if (!req.complete) reject(cutOff());
      });
    });
  }

  async function handleStart(req, res, port) {
    if (!starter) return json(res, 404, { error: "Start is not available" });
    const origin = `http://${(req.headers.host ?? "").toLowerCase()}`;
    if (req.headers["sec-fetch-site"] !== "same-origin") return json(res, 403, { error: "cross-site request refused" });
    if ((req.headers.origin ?? "").toLowerCase() !== origin) return json(res, 403, { error: "origin refused" });
    if (req.headers["x-mc-nonce"] !== nonce) return json(res, 403, { error: "nonce refused", runId });
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON only" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e.status === 408) {
        res.statusCode = 408; // Node has already answered and closed the socket; this is for the log line only
        return;
      }
      return json(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? "body too large" : "invalid JSON" });
    }
    if (!body || typeof body !== "object") return json(res, 400, { error: "invalid body" });
    const project = typeof body.project === "string" ? projects.get(body.project) : null;
    if (!project) return json(res, 404, { error: "unknown project" });
    if (!project.start.enabled) return json(res, 404, { error: "Start is disabled for this project" });
    const number = body.number;
    if (!Number.isSafeInteger(number) || number <= 0) return json(res, 400, { error: "number must be a positive integer" });
    // Per reason, and only a literal true counts: { started, assigned }. Anything else confirms nothing.
    const c = body.confirm && typeof body.confirm === "object" ? body.confirm : {};
    const confirm = { started: c.started === true, assigned: c.assigned === true };

    const { st, refused } = await refresh(project, "start");
    if (refused === "backoff") return json(res, 429, { error: "rate-limit backoff: not refetching before a start" });
    if (st.lastError || !st.normalized) return json(res, 502, { error: `could not refetch the board, not starting: ${st.lastError ?? "no board data"}` });

    const result = await starter.start(project, number, { normalized: st.normalized, confirm });
    // A claim (or an attempt that may have landed, or its undo) changed the board: refetch now, so the page's reload
    // shows GitHub's state instead of a cached Ready.
    if (result.body?.claimed || result.body?.reason === "claim") await refresh(project, "start");
    return json(res, result.status, result.body);
  }

  const timeouts = deps.timeouts ?? {};
  const server = createServer({ connectionsCheckingInterval: timeouts.checkEveryMs ?? CHECK_EVERY_MS }, async (req, res) => {
    const port = server.address()?.port;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const done = (status) => log(`${req.method} ${url.pathname} ${status}`);
    try {
      if (!hostAllowed(req, port)) {
        json(res, 400, { error: "host not allowed" });
        return done(400);
      }
      // A browser marks requests from other sites; refuse them for every API route, so no page elsewhere
      // can force refetches (and spend the rate limit) with an image tag. Absent or "none" means not a browser
      // cross-site request: curl, or the address bar. Current browsers all send the header; one that omits it
      // falls back to the 15 s forced-refresh floor and the Host check. /api/start needs the nonce regardless.
      const site = req.headers["sec-fetch-site"];
      if (url.pathname.startsWith("/api/") && site && site !== "same-origin" && site !== "none") {
        json(res, 403, { error: "cross-site request refused" });
        return done(403);
      }
      if (req.method === "GET" && STATIC.has(url.pathname)) {
        const { file, type } = STATIC.get(url.pathname);
        let body = readFileSync(join(PUBLIC_DIR, file), "utf8");
        if (file === "index.html") body = body.replace("{{NONCE}}", nonce).replace("{{RUN_ID}}", runId);
        send(res, 200, type, body);
        return done(200);
      }
      if (req.method === "GET" && url.pathname === "/api/projects") {
        json(res, 200, [...projects.values()].map((p) => ({ key: p.key, title: p.title })));
        return done(200);
      }
      if (req.method === "GET" && url.pathname === "/api/board") {
        const key = url.searchParams.get("project") ?? (projects.size === 1 ? [...projects.keys()][0] : null);
        const project = key ? projects.get(key) : null;
        if (!project) {
          json(res, 404, { error: "unknown project" });
          return done(404);
        }
        const { st, refused } = await refresh(project, url.searchParams.get("force") === "1" ? "forced" : "scheduled");
        if (!st.data) {
          json(res, 502, { error: st.lastError ?? "no board data", project: { key: project.key, title: project.title }, runId });
          return done(502);
        }
        json(res, 200, boardResponse(project, st, refused));
        return done(200);
      }
      if (req.method === "POST" && url.pathname === "/api/start") {
        await handleStart(req, res, port);
        return done(res.statusCode);
      }
      json(res, 404, { error: "not found" });
      return done(404);
    } catch (e) {
      // The log holds method, path and status, plus the error's class name: never its message, which could carry gh output.
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      log(`${req.method} ${url.pathname} 500 ${e?.name ?? "Error"}`);
    }
  });
  server.requestTimeout = timeouts.requestMs ?? REQUEST_TIMEOUT_MS;
  server.headersTimeout = timeouts.headersMs ?? HEADERS_TIMEOUT_MS;

  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server.address().port));
    });
  }

  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, nonce, runId, listen, close };
}
