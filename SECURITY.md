# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the "Report a vulnerability" button on this repository's Security tab. Do not open a public issue for it. You will get an answer there.

## What this tool trusts

The threat model and the controls are in `README.md` under "Security notes" and in `docs/adr/0001-workbench.md`. In short:

- The server binds `127.0.0.1` only and sends one read-only GraphQL query (`src/board.graphql`) with your own `gh` token. The token never reaches the page, a response or a log line.
- Starting a `claude` session is off by default (`start.enabled`). When on, it is argv only, no shell, and accepts same-origin requests carrying the per-run nonce only.
- Any program already running as your user on the machine can load the page and press Start. It could run `claude` itself, so the dashboard adds no new power there. Treat the machine as single-user.
