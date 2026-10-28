// Colour for what the commands print, on a terminal only.
//
// On when the output is a terminal (a TTY), off when it goes to a file or a pipe.
// NO_COLOR (any value, https://no-color.org) turns it off; FORCE_COLOR turns it on
// anywhere (FORCE_COLOR=0 off), and TERM=dumb off. Decided each time a command
// asks (`colours()`), so a test can turn it on with `colours({ enabled: true })`.

const CODES = { red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39], bold: [1, 22], dim: [2, 22] };

export function colourEnabled(env = process.env, stream = process.stdout) {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return Boolean(stream?.isTTY);
}

// { red, green, yellow, cyan, bold, dim }: each wraps text in its colour, or returns it as it is.
export function colours({ enabled = colourEnabled() } = {}) {
  const paint = {};
  for (const [name, [on, off]] of Object.entries(CODES)) {
    paint[name] = enabled ? (text) => `\x1b[${on}m${text}\x1b[${off}m` : (text) => String(text);
  }
  paint.enabled = enabled;
  return paint;
}

// The text without colour codes, for tests and widths.
export const plain = (text) => String(text).replace(/\x1b\[\d+m/g, "");
