// Tiny argv reader shared by bin/ and scripts/: `--name value` flags and `--switch` switches. A value flag with
// no value is an error, never a silent undefined, so `--project` at the end of a line cannot quietly open the
// first project or write a file called "--synthetic".
export function flagReader(args) {
  const flag = (name, fallback = null) => {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    return value;
  };
  flag.has = (name) => args.includes(name);
  return flag;
}
