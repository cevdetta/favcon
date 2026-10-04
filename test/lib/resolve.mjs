// A var() resolver for reference renders.
//
// A SECOND implementation on purpose, not an import of favcon's. The accuracy gate
// compares favcon's output against a reference render, and if both sides resolved custom
// properties with the same code then a resolver bug would cancel itself out and the gate
// would pass. This one is slower and simpler; that is the point.

const substitute = (text, vars, depth = 0) => {
  if (depth > 32) throw new Error('var() nested too deep');
  let out = '', i = 0;
  for (;;) {
    const at = text.indexOf('var(', i);
    if (at === -1) return out + text.slice(i);
    if (at > 0 && /[\w-]/.test(text[at - 1])) { out += text.slice(i, at + 4); i = at + 4; continue; }
    let depth2 = 0, close = -1;
    for (let j = at + 3; j < text.length; j++) {
      if (text[j] === '(') depth2++;
      else if (text[j] === ')' && --depth2 === 0) { close = j; break; }
    }
    if (close === -1) throw new Error('unbalanced var(');
    const inner = text.slice(at + 4, close);
    let split = -1, d = 0;
    for (let j = 0; j < inner.length; j++) {
      if (inner[j] === '(') d++;
      else if (inner[j] === ')') d--;
      else if (inner[j] === ',' && d === 0) { split = j; break; }
    }
    const name = (split === -1 ? inner : inner.slice(0, split)).trim();
    const fallback = split === -1 ? null : inner.slice(split + 1).trim();
    out += text.slice(i, at);
    if (vars.has(name)) out += vars.get(name);
    else if (fallback !== null) out += substitute(fallback, vars, depth + 1);
    else throw new Error(`unresolved var(${name})`);
    i = close + 1;
  }
};

/** `vars` keys may be given with or without the leading `--`. */
export function resolveVars(svg, vars = {}) {
  const map = new Map();
  for (const [k, v] of Object.entries(vars)) map.set(k.startsWith('--') ? k : '--' + k, String(v));
  return substitute(svg, map);
}
