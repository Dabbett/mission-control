// Flags that take the human out of a `claude` session. The validator refuses them in a config with Start on, and
// bin/launch.mjs refuses them regardless of config, because the Start button is the sign-off point: a one-click
// launch must open an interactive session that asks before it acts.
export const DANGEROUS_FLAGS = /^(--dangerously-skip-permissions|--permission-mode(=.*)?|-p|--print|--allowedTools(=.*)?|--allowed-tools(=.*)?)$/;

/** The first dangerous flag in an argv array, or null. */
export function dangerousFlag(argv) {
  return argv.find((a) => DANGEROUS_FLAGS.test(a)) ?? null;
}
