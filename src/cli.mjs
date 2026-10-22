// Tiny argv reader shared by bin/ and scripts/. Every argument must be a known `--name value` flag, its value, or a
// known `--switch`; anything else (an unknown flag, `--name=value`, a stray word, a value flag with no value) is an
// error, never a silent fallback. So `--project` at the end of a line cannot quietly open the first project,
// `--out=/tmp/x` cannot quietly write the default file, and a typo cannot pass unnoticed.
export function flagReader(args, { values = [], switches = [] }) {
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (values.includes(a) || switches.includes(a)) {
      if (seen.has(a)) throw new Error(`${a} given twice`);
      seen.add(a);
    }
    if (values.includes(a)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a value`);
      i++;
    } else if (!switches.includes(a)) {
      throw new Error(`unknown argument ${a}; flags: ${[...values.map((v) => `${v} <value>`), ...switches].join(", ")}`);
    }
  }
  const flag = (name, fallback = null) => {
    if (!values.includes(name)) throw new Error(`${name} is not a declared value flag`);
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  flag.has = (name) => {
    if (!switches.includes(name) && !values.includes(name)) throw new Error(`${name} is not a declared flag`);
    return args.includes(name);
  };
  return flag;
}
