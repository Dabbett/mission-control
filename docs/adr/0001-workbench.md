# ADR 0001: the Workbench, a drop zone for starting agent sessions

Status: accepted 2026-10-21. Supersedes nothing.

## Context

Start already existed: one button per Ready issue in the drill-in, off unless `start.enabled`. The ask was to drag issues into a zone and start them from there, and to know what that does to safety and to the open questions around blocked work, models and sign-off.

## Decision

1. **Drag stages; only a button starts.** Dropping an issue on the Workbench, or pressing "Add to Workbench", only puts it on the Workbench. A session starts only from the "Start #N" button on a staged card. Start moved out of the drill-in, so every launch passes the card that shows the prose-dependency note. A misplaced drop launches nothing.
2. **Blocked and decision issues can't be staged, and say why.** Only a Ready issue with a command is draggable. Anything else carries a hover reason, and its blockers are linked in the drill-in. `stage()` re-checks Ready, so a forged drop is refused with the reason too. The server re-checks again at Start (`src/start.mjs`).
3. **No override.** If a dev disagrees that something is a blocker, they change the board: remove the blocked-by edge, answer the decision, or rename an `[On hold]` title. The card turns Ready on the next refresh. GitHub's timeline records who did it. An override button would make the dashboard a second source of truth and bypass the rule that agents don't start on items with open prerequisites.
4. **Model: a config default, overridden by one issue label, from an allowlist.** `model.default`, `model.allowed` and `model.labelPrefix` (default `model:`) live in the project config. The command gets `--model <name>` after `claude`. A label naming a model outside the allowlist, or two different model labels, gives the issue no command, with the reason shown. It never silently falls back to the default. Names must match `^[a-z0-9][a-z0-9.-]*$`, so a model can't be shaped like a flag.
5. **Agents claim the issue first, best-effort.** The example prompt tells the agent to assign itself and set Status to In progress before anything else, so a second person or tab sees it as taken. The prompt is an instruction, not a lock: until the agent acts, the board still says Ready. The mechanism behind it is that Start asks for a confirm when the refetched issue already has an assignee. Confirms are per reason (`started`, `assigned`): the Start button names every reason it confirms, and agreeing to one never passes the other, so a stale page can't confirm a reason it never showed. The dashboard itself stays read-only: the claim is written by the Claude session, with the user's `gh` login.
6. **A staged card that stops being Ready turns red** and loses its Start button, with the reason.
7. **Soft concurrency warning.** At 2 or more starts in one server run, the Workbench warns that each is a full Claude session. There's no hard cap, because the dashboard can't see when a session ends.
8. **No persistence.** The Workbench empties on reload. Restaging takes seconds, and browser storage would be a second record of intent.

## Sign-off points

- **To begin:** pressing Start on a staged card, beside the prose-dependency note and the model.
- **During the work:** the prompt makes the agent stop and ask if a decision isn't in the spec or an ADR.
- **To ship:** the agent runs the review loop and opens a PR. CI, CODEOWNERS and a human approval gate the merge, and no part of this tool can merge.

## Safety check (2026-10-21, manual, not automated)

A throwaway copy with Start enabled and the launcher replaced by a logger was attacked from pages on `localhost:8899` and `127.0.0.1:8899` in Chrome:

| Attempt | Result |
|---|---|
| Read the dashboard page to get the nonce | Blocked by the browser (no CORS header) |
| `no-cors` text/plain POST to `/api/start` | 403 |
| JSON POST with a guessed nonce | Preflight (`OPTIONS`) 403; POST never sent |
| HTML form POST into an iframe | 403 |
| Forced board refresh | 403 |
| Control: same-origin start from the dashboard page | 200, launcher logged the command |

Nothing from the attacker pages reached the launcher. DNS rebinding was not tried live; the Host allowlist and its unit test cover it. Not covered: any program already running as the user on the Mac can load the page and press Start. It could just as well run `claude` itself, so the dashboard adds no new power there.

## Consequences

- Start takes two steps: stage, then press Start. If the card already names a reason (started, assigned), that same press is the confirm. A reason that appears after the card was drawn costs one refused press, which lists every missing reason at once.
- With a `model.default` set, the command for every issue carries `--model <default>` unless a label says otherwise.
- Adding a model means adding it to `model.allowed`.
