#!/usr/bin/env node
// Records one live board as a fixture.
// Default: the raw recording (logins replaced, node ids dropped) is written OUTSIDE the repo, under
// ${XDG_STATE_HOME:-~/.local/state}/mission-control/fixtures/, because it still holds every title and label.
// --synthetic: runs scripts/scrub-fixture.mjs over it (generic text, example-org, shifted numbers) and writes
// test/fixtures/board-example.json. Only that mode may write under test/fixtures/; test/publish-guard.test.mjs
// checks the result.
// Usage: node scripts/record-fixture.mjs [--project <key>] [--config-dir <dir>] [--synthetic] [--out <file>]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { flagReader } from "../src/cli.mjs";
import { expandHome, loadProjects, pickProject, resolveConfigDir } from "../src/config.mjs";
import { fetchBoard } from "../src/github.mjs";
import { loadDenylist } from "./denylist.mjs";
import { EXAMPLE, scrubFixture } from "./scrub-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = flagReader(process.argv.slice(2));
const synthetic = flag.has("--synthetic");

let project, out;
try {
  const { dir } = resolveConfigDir({ explicit: flag("--config-dir", process.env.MC_CONFIG_DIR ?? null), root });
  const projects = loadProjects(dir);
  project = projects.get(pickProject(projects, flag("--project", process.env.MC_PROJECT ?? null)));
  const stateHome = process.env.XDG_STATE_HOME ? resolve(expandHome(process.env.XDG_STATE_HOME)) : join(homedir(), ".local", "state");
  const defaultOut = synthetic ? join(root, "test", "fixtures", `board-${EXAMPLE.key}.json`) : join(stateHome, "mission-control", "fixtures", `board-${project.key}.json`);
  out = resolve(flag("--out") ? expandHome(flag("--out")) : defaultOut);
} catch (e) {
  console.error(`record-fixture: ${e.message}`);
  process.exit(1);
}

const fixturesDir = join(root, "test", "fixtures");
const rel = relative(fixturesDir, out);
const insideFixtures = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
if (insideFixtures && !synthetic) {
  console.error(`refusing to write a raw recording under ${fixturesDir}: it would hold the real board's titles. Add --synthetic, or --out <file> somewhere else.`);
  process.exit(1);
}

const logins = new Map();
function scrubLogin(login) {
  if (!logins.has(login)) logins.set(login, `user${logins.size + 1}`);
  return logins.get(login);
}

function scrub(node) {
  const copy = JSON.parse(JSON.stringify(node));
  delete copy.id;
  const c = copy.content;
  if (c?.assignees?.nodes) c.assignees.nodes = c.assignees.nodes.map((a) => ({ login: scrubLogin(a.login) }));
  return copy;
}

const board = await fetchBoard(project);
let fixture = {
  recordedAt: board.fetchedAt,
  project: { key: project.key, org: project.org, projectNumber: project.projectNumber, title: board.title, url: board.url },
  rateLimit: { cost: board.rateLimit?.cost ?? null },
  nodes: board.nodes.map(scrub),
};
let note = `raw recording: it holds every title and label of ${project.repo}. Keep it out of the repo.`;
if (synthetic) {
  // Refuse to write anything that still names the source board, or that matches the publish denylist.
  const exampleWords = Object.values(EXAMPLE).map(String);
  const words = [project.org, project.repo.split("/")[1], project.title, board.title].filter((s) => s && !exampleWords.includes(s));
  const { patterns, privateSource } = loadDenylist({ root });
  if (!privateSource) console.error("warning: no private denylist (MC_DENYLIST or ~/.config/mission-control/denylist.txt); checking the board's own names only");
  const scrubbed = scrubFixture(fixture, {
    epicLabel: project.epicLabel,
    modelLabelPrefix: project.model?.labelPrefix ?? "model:",
    status: project.status,
    decisionType: project.decisionType,
    forbid: [...words, ...patterns],
  });
  fixture = scrubbed.fixture;
  note = `synthetic: generic text, ${EXAMPLE.repo}, numbers shifted by -${scrubbed.offset}.`;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Recorded ${fixture.nodes.length} items to ${out} (query cost ${fixture.rateLimit.cost}). ${note}`);
