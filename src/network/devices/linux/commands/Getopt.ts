export type ShortOption =
  | { readonly kind: 'option'; readonly letter: string; readonly argument?: string }
  | { readonly kind: 'operand'; readonly value: string; readonly index: number }
  | { readonly kind: 'invalid'; readonly letter: string }
  | { readonly kind: 'missing-argument'; readonly letter: string; readonly long?: string }
  | { readonly kind: 'unrecognized'; readonly token: string }
  | { readonly kind: 'needless-argument'; readonly long: string };

export type GetoptFailure = Extract<ShortOption, {
  kind: 'invalid' | 'missing-argument' | 'unrecognized' | 'needless-argument';
}>;

export interface LongOption {
  readonly name: string;
  readonly letter: string;
  readonly takesArgument: boolean;
}

function matchLongOption(longOptions: readonly LongOption[], name: string): LongOption | undefined {
  const exact = longOptions.find((o) => o.name === name);
  if (exact || name.length === 0) return exact;
  const byPrefix = longOptions.filter((o) => o.name.startsWith(name));
  return byPrefix.length === 1 ? byPrefix[0] : undefined;
}

function* longOption(
  token: string, args: readonly string[], at: number, longOptions: readonly LongOption[],
): Generator<ShortOption, number> {
  const eq = token.indexOf('=');
  const name = token.slice(2, eq < 0 ? undefined : eq);
  const inline = eq < 0 ? undefined : token.slice(eq + 1);
  const option = matchLongOption(longOptions, name);
  if (!option) {
    yield { kind: 'unrecognized', token };
    return at;
  }
  if (!option.takesArgument) {
    yield inline === undefined ? { kind: 'option', letter: option.letter } : { kind: 'needless-argument', long: option.name };
    return at;
  }
  if (inline !== undefined) {
    yield { kind: 'option', letter: option.letter, argument: inline };
    return at;
  }
  if (at + 1 < args.length) {
    yield { kind: 'option', letter: option.letter, argument: args[at + 1] };
    return at + 1;
  }
  yield { kind: 'missing-argument', letter: option.letter, long: option.name };
  return at;
}

export function* shortOptions(
  args: readonly string[], optstring: string, longOptions: readonly LongOption[] = [],
): Generator<ShortOption> {
  const stopAtFirstOperand = optstring.startsWith('+');
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (optionsEnded || token === '-' || !token.startsWith('-')) {
      if (stopAtFirstOperand) optionsEnded = true;
      yield { kind: 'operand', value: token, index: i };
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (longOptions.length > 0 && token.startsWith('--')) {
      i = yield* longOption(token, args, i, longOptions);
      continue;
    }
    for (let j = 1; j < token.length; j++) {
      const letter = token[j];
      const at = optstring.indexOf(letter);
      if (at < 0 || letter === ':' || (stopAtFirstOperand && at === 0)) {
        yield { kind: 'invalid', letter };
        continue;
      }
      if (optstring[at + 1] !== ':') {
        yield { kind: 'option', letter };
        continue;
      }
      if (optstring[at + 2] === ':') {
        yield j + 1 < token.length ? { kind: 'option', letter, argument: token.slice(j + 1) } : { kind: 'option', letter };
        break;
      }
      if (j + 1 < token.length) yield { kind: 'option', letter, argument: token.slice(j + 1) };
      else if (i + 1 < args.length) yield { kind: 'option', letter, argument: args[++i] };
      else yield { kind: 'missing-argument', letter };
      break;
    }
  }
}

export function getoptDiagnostic(program: string, failure: GetoptFailure): string {
  switch (failure.kind) {
    case 'invalid':
      return `${program}: invalid option -- '${failure.letter}'`;
    case 'missing-argument':
      return failure.long === undefined
        ? `${program}: option requires an argument -- '${failure.letter}'`
        : `${program}: option '--${failure.long}' requires an argument`;
    case 'unrecognized':
      return `${program}: unrecognized option '${failure.token}'`;
    case 'needless-argument':
      return `${program}: option '--${failure.long}' doesn't allow an argument`;
  }
}

export function bsdGetoptDiagnostic(failure: Extract<GetoptFailure, { kind: 'invalid' | 'missing-argument' }>): string {
  return failure.kind === 'invalid'
    ? `unknown option -- ${failure.letter}`
    : `option requires an argument -- ${failure.letter}`;
}
