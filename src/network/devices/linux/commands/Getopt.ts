export type ShortOption =
  | { readonly kind: 'option'; readonly letter: string; readonly argument?: string }
  | { readonly kind: 'operand'; readonly value: string }
  | { readonly kind: 'invalid'; readonly letter: string }
  | { readonly kind: 'missing-argument'; readonly letter: string };

export type GetoptFailure = Extract<ShortOption, { kind: 'invalid' | 'missing-argument' }>;

export function* shortOptions(args: readonly string[], optstring: string): Generator<ShortOption> {
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (optionsEnded || token === '-' || !token.startsWith('-')) {
      yield { kind: 'operand', value: token };
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    for (let j = 1; j < token.length; j++) {
      const letter = token[j];
      const at = optstring.indexOf(letter);
      if (at < 0 || letter === ':') {
        yield { kind: 'invalid', letter };
        continue;
      }
      if (optstring[at + 1] !== ':') {
        yield { kind: 'option', letter };
        continue;
      }
      if (j + 1 < token.length) yield { kind: 'option', letter, argument: token.slice(j + 1) };
      else if (i + 1 < args.length) yield { kind: 'option', letter, argument: args[++i] };
      else yield { kind: 'missing-argument', letter };
      break;
    }
  }
}

export function getoptDiagnostic(program: string, failure: GetoptFailure): string {
  return failure.kind === 'invalid'
    ? `${program}: invalid option -- '${failure.letter}'`
    : `${program}: option requires an argument -- '${failure.letter}'`;
}
