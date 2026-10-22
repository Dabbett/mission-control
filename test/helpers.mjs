import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjects } from "../src/config.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The shipped projects/ folder (the example config), loaded directly so tests never read a user's config dir. */
export function exampleProjects(overrides = {}) {
  const map = loadProjects(join(root, "projects"));
  const s = map.get("example");
  map.set("example", { ...s, ...overrides, start: { ...s.start, ...(overrides.start ?? {}) } });
  return map;
}

/** The raw example.json, for tests that revalidate a modified copy. */
export function exampleRaw() {
  return JSON.parse(readFileSync(join(root, "projects", "example.json"), "utf8"));
}

/** The synthetic board recording (see scripts/scrub-fixture.mjs), shaped like a live fetchBoard result. */
export function fixtureBoard() {
  const f = JSON.parse(readFileSync(join(root, "test", "fixtures", "board-example.json"), "utf8"));
  return { title: f.project.title, url: f.project.url, nodes: f.nodes, rateLimit: { cost: 46, remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() }, fetchedAt: f.recordedAt };
}

/** Raw HTTP request so tests can set any Host or Origin header. */
export function http(port, path, { method = "GET", headers = {}, body = null, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** The fixture with the ids a claim needs, as the live board query returns them. */
export function claimableBoard(board = fixtureBoard()) {
  for (const n of board.nodes) {
    if (n.content?.__typename !== "Issue") continue;
    n.id = `PVTI_${n.content.number}`;
    n.content.id = `I_${n.content.number}`;
  }
  return {
    ...board,
    projectId: "PVT_1",
    viewer: { id: "U_me", login: "me" },
    statusField: { id: "F_status", options: [{ id: "O_todo", name: "Todo" }, { id: "O_prog", name: "In progress" }, { id: "O_rev", name: "In review" }, { id: "O_done", name: "Done" }] },
  };
}
