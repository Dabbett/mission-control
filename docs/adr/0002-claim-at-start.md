# ADR 0002: Start can claim the issue on GitHub, opt-in

Status: accepted 2026-10-22. Supersedes decision 5 of ADR 0001 for projects with `start.claim: "dashboard"`; for every other project, decision 5 stands.

## Context

ADR 0001 left the claim to the agent: the prompt asks the session to assign itself and set Status to In progress. In practice that write is the session's first `gh` command, which waits on a permission prompt in a window nobody may be watching. Until someone answers, the board says Ready. A second Start after a server restart (the in-memory "started" marker is gone), from a second machine, or by a second person then launches a second agent into the same worktree. The review of 2026-10-21 reproduced the restart case offline and recommended this change before anyone else installs the tool.

## Decision

1. **Opt-in, per project.** `start.claim` is `"agent"` (the default: ADR 0001 decision 5, unchanged) or `"dashboard"`. `"dashboard"` needs Start on and a name in `status.inProgress`.
2. **The claim is two writes, before the launch.** After a Start passes every existing check (refetched board, Ready, confirms, checkout), the server assigns the token's user and sets the issue's Status to the first name in `status.inProgress`. Only then does it open the session. A second Start anywhere refetches, sees In progress, and is refused by the Ready check, with no new rule.
3. **Exactly two write documents, guarded like the read.** `src/claim.graphql` (`addAssigneesToAssignable`, `updateProjectV2ItemFieldValue`) and `src/unclaim.graphql` (`removeAssigneesFromAssignable`, `updateProjectV2ItemFieldValue`, `clearProjectV2ItemFieldValue`). `src/readonly.mjs` refuses at load a write document with more than one operation, a root field off its list, an alias or a fragment. `src/claim.mjs` is the only module that sends them, `src/start.mjs` the only one that calls it, and the board read in `src/github.mjs` stays a single query. Tests pin all of this.
4. **Undo what the claim changed, and only what is safe.** After a half-landed claim (GitHub said which half) or a failed launch, the undo removes the assignee only if the claim added it, and puts the Status back to what it was (or clears it if there was none). When the claim is contested (a stranger among the assignees, or no assignee list in the reply) or its answer was lost (a timeout, a dropped connection, a 5xx), the undo removes only our assignee and leaves the Status: someone else's session may be running, and two sessions on one issue is the failure this ADR exists to prevent. If the undo fails, the refusal says to fix the assignee and Status by hand. Nothing launches after a failed, contested or doubtful claim.
5. **The same person, the same token.** The claim uses the token the board read uses (`MISSION_CONTROL_TOKEN`, else the `gh` login), so it appears on the issue timeline under the user who pressed Start, as the agent's own write would have. A read-only token cannot claim; the refusal says so and nothing launches.
6. **Starting is still a human act.** The claim happens only on a Start press, which ADR 0001 already makes the sign-off point. Pressing Start is the person setting Status, as a project rule like "Status is set by hand" means it.

## Consequences

- "Read-only toward GitHub" becomes "read-only, except the opt-in claim at Start". The read path's proof is unchanged; the write path has its own.
- Two presses in the same second on two machines can both claim. The reply to the claim lists the assignees, so a side that sees a stranger backs off. If both replies list both people, both back off and the issue is left In progress with no session: the refusal says to set the Status back by hand if no session started on either side. Failing toward "nobody started" rather than "two started" is deliberate. A narrower window, not a lock.
- A crash between the claim and the launch leaves the issue In progress with no session. That is recoverable by changing the board (ADR 0001 decision 3), and visible there.
- With the claim on, the prompt's own claim sentence is redundant; remove it from the project's prompt.
- Projects that keep `"agent"` still need the session record planned next (which sessions this machine started, alive or not) to stop a restart double-start.
