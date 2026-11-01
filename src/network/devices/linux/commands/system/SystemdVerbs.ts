export interface SystemdVerb {
  readonly name: string;
  readonly maxArguments: number | null;
}

const CLOSEST_VERB_DISTANCE_LIMIT = 5;

export function strlevenshtein(x: string, y: string): number {
  if (x === y) return 0;
  if (x === '') return y.length;
  if (y === '') return x.length;
  let older = new Array<number>(y.length + 1).fill(0);
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  let current = new Array<number>(y.length + 1).fill(0);
  for (let i = 0; i < x.length; i++) {
    current[0] = i + 1;
    for (let j = 0; j < y.length; j++) {
      current[j + 1] = previous[j] + (x[i] === y[j] ? 0 : 1);
      if (i > 0 && j > 0 && x[i - 1] === y[j] && x[i] === y[j - 1] && current[j + 1] > older[j - 1] + 1) current[j + 1] = older[j - 1] + 1;
      if (current[j + 1] > previous[j + 1] + 1) current[j + 1] = previous[j + 1] + 1;
      if (current[j + 1] > current[j] + 1) current[j + 1] = current[j] + 1;
    }
    [older, previous, current] = [previous, current, older];
  }
  return previous[y.length];
}

function prefixVerb<T extends SystemdVerb>(name: string, verbs: readonly T[]): T | null {
  let best: T | null = null;
  let bestRemainder = Infinity;
  for (const verb of verbs) {
    if (!verb.name.startsWith(name)) continue;
    const remainder = verb.name.length - name.length;
    if (remainder < bestRemainder) { bestRemainder = remainder; best = verb; }
  }
  return best;
}

function closestVerb<T extends SystemdVerb>(name: string, verbs: readonly T[]): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const verb of verbs) {
    const distance = strlevenshtein(verb.name, name);
    if (distance > CLOSEST_VERB_DISTANCE_LIMIT) continue;
    if (distance < bestDistance) { bestDistance = distance; best = verb; }
  }
  return best;
}

export type VerbResolution<T extends SystemdVerb> =
  | { readonly verb: T }
  | { readonly error: string };

export function resolveVerb<T extends SystemdVerb>(operands: readonly string[], verbs: readonly T[]): VerbResolution<T> {
  const name = operands[0];
  if (name === undefined) return { error: 'Command verb required.' };
  const exact = verbs.find((verb) => verb.name === name);
  if (exact === undefined) {
    const guess = prefixVerb(name, verbs) ?? closestVerb(name, verbs);
    return { error: guess === null ? `Unknown command verb '${name}'.` : `Unknown command verb '${name}', did you mean '${guess.name}'?` };
  }
  if (exact.maxArguments !== null && operands.length > exact.maxArguments) return { error: 'Too many arguments.' };
  return { verb: exact };
}
