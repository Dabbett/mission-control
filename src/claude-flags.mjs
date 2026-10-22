// Flags that take the human out of a `claude` session. The validator refuses them in a config with Start on, and
// bin/launch.mjs refuses them regardless of config, because the Start button is the sign-off point: a one-click
// launch must open an interactive session that asks before it acts.
// --settings can carry a permission mode or allow rules as inline JSON; --setting-sources can skip the user's own
// settings, and with them their deny rules. Neither this list nor the launcher sees the target repo's own
// .claude/settings.json, which can set the same things.
export const DANGEROUS_FLAGS = /^(--dangerously-skip-permissions|--permission-mode(=.*)?|-p|--print|--allowedTools(=.*)?|--allowed-tools(=.*)?|--settings(=.*)?|--setting-sources(=.*)?)$/;

/** The first dangerous flag in an argv array, or null. */
export function dangerousFlag(argv) {
  return argv.find((a) => DANGEROUS_FLAGS.test(a)) ?? null;
}
