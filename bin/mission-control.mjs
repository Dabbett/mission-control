#!/usr/bin/env node
// Usage: node bin/mission-control.mjs [--project <key>] [--port 7187] [--config-dir <dir>] [--no-open]
// Environment: MC_PORT, MC_PROJECT, MC_CONFIG_DIR (a flag wins over its variable).
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flagReader } from "../src/cli.mjs";
import { loadProjects, pickProject, resolveConfigDir } from "../src/config.mjs";
import { fetchBoard } from "../src/github.mjs";
import { createApp } from "../src/server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = flagReader(process.argv.slice(2));

let port, config, projects, key;
try {
  port = Number(flag("--port", process.env.MC_PORT ?? "7187"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
  config = resolveConfigDir({ explicit: flag("--config-dir", process.env.MC_CONFIG_DIR ?? null), root });
  projects = loadProjects(config.dir);
  key = pickProject(projects, flag("--project", process.env.MC_PROJECT ?? null));
} catch (e) {
  console.error(`mission-control: ${e.message}`);
  process.exit(1);
}
if (config.source === "repo") {
  console.log(`config: no project files in ${config.userDir}; serving the shipped example from ${config.dir}.`);
  console.log(`        To show your own board: copy projects/example.json to ${join(config.userDir, "<key>.json")} and edit org, projectNumber, repo and localPath.`);
} else {
  console.log(`config: ${config.dir}`);
}
if (projects.size > 1 && !flag.has("--project") && !process.env.MC_PROJECT) {
  console.log(`projects: ${[...projects.keys()].join(", ")}; opening "${key}" (pass --project to choose)`);
}

const anyStart = [...projects.values()].some((p) => p.start.enabled);
const { createStarter } = anyStart ? await import("../src/start.mjs") : { createStarter: null };
const app = createApp({
  projects,
  fetchBoard,
  log: (line) => console.log(new Date().toISOString().slice(11, 19), line),
  starter: anyStart ? createStarter({ root }) : null,
});

const bound = await app.listen(port);
const url = `http://127.0.0.1:${bound}/?project=${encodeURIComponent(key)}`;
console.log(`mission control on ${url}  (read-only; Start ${anyStart ? "enabled for: " + [...projects.values()].filter((p) => p.start.enabled).map((p) => p.key).join(", ") : "off"})`);
if (!flag.has("--no-open") && process.platform === "darwin") execFile("open", [url], () => {});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.close().then(() => process.exit(0)));
