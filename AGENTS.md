# Working in this repo

Read this before changing anything. `README.md` explains what the tool does; this file is the rules.

## Run and test

- Node 22 (`.nvmrc`), no dependencies. `npm test` runs everything offline and must pass before a push.
- CI is written for the published repository: it needs the `MC_DENYLIST` secret, set twice (as an Actions secret and as a Dependabot secret, because Dependabot's runs see only the latter), and noreply commit e-mails. A private working copy that commits with other e-mails can set the `MC_ALLOWED_EMAILS` repository variable (a regular expression) to allow those addresses as well; an address allowed that way still fails if its domain is on the denylist.
- `node bin/mission-control.mjs --no-open` starts the server on `127.0.0.1:7187`.

## Rules that hold

1. **No real board recordings in the repo.** `test/fixtures/` holds synthetic boards only: `example-org/example-app`, generic titles, shifted numbers. `npm run record-fixture` writes a real recording outside the repo; only `npm run record-fixture -- --synthetic` may write under `test/fixtures/`. `test/publish-guard.test.mjs` fails the suite on anything else.
2. **Project config lives outside the repo**, in `~/.config/mission-control/projects/`. `projects/` ships `example.json` only; `.gitignore` ignores every other file there, and the guard test checks it. Never commit a real org, repo, path or prompt.
3. **No client or personal names, machine paths or e-mail addresses.** The guard test runs the denylist over every tracked file: generic patterns from `.github/denylist.txt` plus a private list of names kept outside the tree on purpose (`~/.config/mission-control/denylist.txt`, or the `MC_DENYLIST` secret in CI, where it is required). Never add a name to the tree file: that would publish it. Commit with your GitHub noreply address; `scripts/check-history.mjs` checks commit messages and e-mail addresses in CI. GitHub noreply addresses, GitHub's bot senders and generic no-reply senders (a `Co-Authored-By` trailer, say) pass, but every address's domain is scanned against the denylist; `MC_ALLOWED_EMAILS` adds more.
4. **Read-only toward GitHub.** One GraphQL document, `src/board.graphql`, type `query`. `src/readonly.mjs` refuses anything else at load and `test/readonly.test.mjs` proves it. Do not add a mutation.
5. **No shell between the page and `claude`.** Commands are argv arrays; `bin/launch.mjs` runs only `claude`. `test/prompt.test.mjs` ("nothing under src/ or bin/ spawns through a shell") greps `src/` and `bin/` for `shell: true`.
6. **The token is never logged or returned.** Fixed-string errors only.

## Changing behaviour

- The state rules live in `src/model.mjs` and the table in `README.md` ("Where status comes from"); change both.
- Decisions that shape the design get an ADR in `docs/adr/`.

## License

All rights reserved by Bradash Digital LLC (`LICENSE`). Using or changing this code outside that organization needs its written permission first.
