// Flags that take the human out of a `claude` session. The validator refuses them in a config with Start on, and
// bin/launch.mjs refuses them regardless of config, because the Start button is the sign-off point: a one-click
// launch must open an interactive session that asks before it acts.
// --settings can carry a permission mode or allow rules as inline JSON; --setting-sources can skip the user's own
// settings, and with them their deny rules. Neither this list nor the launcher sees the target repo's own
// .claude/settings.json, which can set the same things.
// --allow-dangerously-skip-permissions makes bypass a mode the session can switch to. A cluster of short flags
// such as -cp carries -p.
export const DANGEROUS_FLAGS = /^(--(allow-)?dangerously-skip-permissions|--permission-mode(=.*)?|-[a-zA-Z]*p[a-zA-Z]*|--print|--allowedTools(=.*)?|--allowed-tools(=.*)?|--settings(=.*)?|--setting-sources(=.*)?)$/;

/** The first dangerous flag in an argv array, or null. */
export function dangerousFlag(argv) {
  return argv.find((a) => DANGEROUS_FLAGS.test(a)) ?? null;
}
