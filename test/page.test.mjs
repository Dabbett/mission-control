import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./helpers.mjs";

const html = readFileSync(join(root, "public", "index.html"), "utf8");
const js = readFileSync(join(root, "public", "app.js"), "utf8");
const css = readFileSync(join(root, "public", "app.css"), "utf8");

test("page: no HTML injection sinks", () => {
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "DOMParser", "eval(", "new Function"]) {
    assert.ok(!js.includes(sink), `app.js uses ${sink}`);
    assert.ok(!html.includes(sink), `index.html uses ${sink}`);
  }
});

test("page: no inline script, no inline style, nothing the CSP would block", () => {
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /src="\/app\.js"/);
  assert.ok(!/<script\b[^>]*>[^<]*\S[^<]*<\/script>/.test(html), "inline script body");
  assert.ok(!/\bstyle=/.test(html), "style= attribute in index.html");
  assert.ok(!/\bstyle=/.test(js), "style= attribute built in app.js");
  assert.ok(!/setAttribute\(\s*["']style["']/.test(js), "setAttribute('style') in app.js");
  assert.ok(!/\son[a-z]+=/i.test(html), "inline event handler in index.html");
  assert.ok(!/javascript:/i.test(js + html + css), "javascript: URL");
  assert.ok(!/url\(\s*["']?https?:/i.test(css), "remote URL in CSS");
  assert.ok(!/<link\b[^>]*href="(?!\/app\.css")/.test(html), "external stylesheet");
});

test("page: the only href sink is github() and it requires a GitHub URL", () => {
  const hrefs = js.match(/href/g) ?? [];
  // one in the github() helper, one for the board link in renderHud, both guarded by the same prefix check
  assert.equal(hrefs.length, 2, "href appears outside the two guarded sinks");
  assert.ok(js.includes('url.startsWith("https://github.com/")) a.setAttribute("href", url)'), "github() guard");
  assert.match(js, /b\.board\.url\.startsWith\("https:\/\/github\.com\/"\)\)\s*\{\s*link\.setAttribute\("href", b\.board\.url\)/, "board link guard");
  assert.ok(!/\.href\s*=/.test(js), ".href assignment");
  assert.ok(!/location\s*=|location\.assign|location\.replace|window\.open/.test(js), "navigation sink");
});

test("page: every external link opens in a new tab without a referrer", () => {
  assert.ok(js.includes('rel: "noopener noreferrer"'));
  assert.ok(/rel="noopener"/.test(html));
});

test("page: the nonce comes from the meta tag and goes only to /api/start", () => {
  assert.ok(html.includes('<meta name="mc-nonce" content="{{NONCE}}">'));
  assert.match(js, /querySelector\('meta\[name="mc-nonce"\]'\)/);
  const uses = js.match(/x-mc-nonce/g) ?? [];
  assert.equal(uses.length, 1);
  assert.match(js, /fetch\("\/api\/start"[\s\S]{0,200}"x-mc-nonce": NONCE/);
});

test("page: fetches only same-origin relative API paths", () => {
  const fetches = js.match(/fetch\(([^,)]+)/g) ?? [];
  assert.ok(fetches.length >= 3);
  for (const f of fetches) assert.match(f, /fetch\((`\/api\/|"\/api\/)/, f);
});

test("page: every Ready leaf carries the prose-dependency note, and polling survives a failed load", () => {
  assert.ok(js.includes("No blocking edges on the board."));
  assert.ok(!/else if \(l\.state === "ready"\)/.test(js), "the note must not be gated on the copy line");
  assert.match(js, /if \(l\.state === "ready"\) \{\s*\/\/[^\n]*\n\s*box\.append\(el\("div", \{ class: "sub", text: "No blocking edges/);
  const schedules = js.match(/schedule\(board\?\.refreshSeconds \?\? 60\)/g) ?? [];
  assert.equal(schedules.length, 2, "both failure branches reschedule");
  assert.match(js, /visibilitychange[\s\S]{0,120}if \(!document\.hidden\) load\(false\)/, "a visible tab reloads even when no board was ever loaded");
});

test("page: rings use SVG attributes, not inline styles", () => {
  assert.match(js, /"stroke-dasharray":/);
  assert.ok(!js.includes(".style."), "CSSOM style mutation; keep rings on attributes");
});

test("page: only a Ready leaf with a command is draggable; others say why", () => {
  const draggable = js.match(/setAttribute\("draggable", "true"\)/g) ?? [];
  assert.equal(draggable.length, 1, "one draggable sink");
  assert.match(js, /if \(l\.state === "ready"\) \{[\s\S]*?if \(l\.copy\) \{[\s\S]*?setAttribute\("draggable", "true"\)/, "draggable sits inside the Ready + command branch");
  assert.match(js, /\} else \{\s*box\.setAttribute\("title", notStageable\(l\)\);/, "non-Ready leaves explain");
  assert.match(js, /function notStageable\(l\) \{\s*if \(l\.state === "blocked" \|\| l\.state === "decision"\)/, "only Blocked and Decision get the change-the-board hint");
});

test("page: switching projects empties the Workbench", () => {
  assert.match(js, /sel\.addEventListener\("change", \(\) => \{[\s\S]{0,400}staged\.length = 0;\s*board = null;\s*clear\(document\.getElementById\("workbench"\)\);/, "old cards leave the screen at once");
  assert.match(js, /if \(asked !== projectKey\) return;/, "a late answer for the old project is dropped");
});

test("page: a Start click confirms exactly the reasons its label shows, and nothing is remembered", () => {
  assert.ok(!js.includes("pendingConfirm"), "no remembered confirm that could carry over to an unseen reason");
  assert.match(js, /if \(startedAt\) reasons\.push\([^\n]*\n\s*if \(l\.assignees\.length\) reasons\.push\([^\n]*\n\s*const confirm = \{ started: Boolean\(startedAt\), assigned: l\.assignees\.length > 0 \};\n\s*const label = reasons\.length \?/, "label reasons and confirm flags come from the same two facts");
  assert.match(js, /body: JSON\.stringify\(\{ project: asked, number, confirm \}\)/, "the click sends that object as is");
  assert.match(js, /data\.requiresConfirm\) \{[^}]*toast\([^\n]*\n\s*await load\(false\);/, "an unseen reason reloads the card instead of arming a confirm");
});

test("page: the Workbench accepts only its own drag type and re-checks Ready before staging", () => {
  const typeChecks = js.match(/e\.dataTransfer\.types\.includes\(DRAG_TYPE\)/g) ?? [];
  assert.equal(typeChecks.length, 2, "dragover and drop both check the type");
  assert.match(js, /function stage\(number\) \{[\s\S]*?if \(l\.state !== "ready"\) return toast[\s\S]*?if \(!l\.copy\) return toast[\s\S]*?staged\.push\(number\)/);
});

test("page: Start lives only on a Ready staged card, next to the prose-dependency note", () => {
  const starts = js.match(/startIssue\(number, e\.currentTarget, confirm\)/g) ?? [];
  assert.equal(starts.length, 1, "one Start button");
  assert.ok(!js.includes("startIssue(l.number"), "no Start in the drill-in");
  assert.match(js, /function stagedCard[\s\S]*?const ready = l && l\.state === "ready" && l\.copy;[\s\S]*?No blocking edges on the board\.[\s\S]*?if \(ready && b\.start\?\.enabled\)/);
  assert.match(js, /MANY_STARTED = 2/);
});
