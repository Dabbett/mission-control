// The GitHub token: MISSION_CONTROL_TOKEN when set, else the user's `gh` login. Shared by the board read and the
// opt-in claim, so both act as the same person. The token is never logged or returned (AGENTS.md rule 6).
import { execFile } from "node:child_process";

let cachedToken = null;

export function getToken() {
  if (process.env.MISSION_CONTROL_TOKEN) return Promise.resolve(process.env.MISSION_CONTROL_TOKEN);
  if (cachedToken) return Promise.resolve(cachedToken);
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { timeout: 10_000 }, (err, stdout) => {
      const token = (stdout || "").trim();
      if (err || !token) {
        reject(new Error("gh is not logged in. Run `gh auth login`, or set MISSION_CONTROL_TOKEN to a token."));
        return;
      }
      cachedToken = token;
      resolve(token);
    });
  });
}

/** After a 401, the next call asks gh again instead of reusing a revoked token. */
export function forgetToken() {
  cachedToken = null;
}
