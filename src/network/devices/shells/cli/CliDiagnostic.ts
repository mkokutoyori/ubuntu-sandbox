import { formatInvalidInput } from '../CommandTrie';

export type CliErrorKind = 'invalid' | 'incomplete' | 'ambiguous' | 'unknown-exec';

export interface CliDiagnosticContext {
  readonly line: string;
  readonly tokenOffset?: number;
  readonly token?: string;
}

export class CliInvalidInput extends Error {
  readonly argIndex?: number;
  readonly token?: string;

  private readonly jetonNomme: boolean;

  constructor(at?: { argIndex?: number; token?: string }) {
    super('% Invalid input detected at \'^\' marker.');
    this.name = 'CliInvalidInput';
    this.argIndex = at?.argIndex;
    this.token = at?.token;
    this.jetonNomme = at !== undefined && 'token' in at;
  }

  /**
   * Un mot ABSENT n'est pas un mot faux.
   *
   * Vingt-huit gestionnaires refusent leur sous-commande par
   * `throw new CliInvalidInput({ token: args[0] })`, et `args[0]` vaut
   * `undefined` quand rien n'a ete tape : `debug aaa` repondait donc
   * « ce mot n'existe pas » a une ligne ou aucun mot n'a ete ecrit,
   * alors que son aide venait d'en proposer trois. IOS distingue les
   * deux, et la distinction est la seule information utile — l'une dit
   * « continuez », l'autre « recommencez ».
   *
   * La regle est posee ICI plutot qu'aux vingt-huit appels : chacun
   * enonce deja la bonne chose (« ce jeton-la ne convient pas »), et
   * c'est la lecture d'un jeton absent qui etait fausse.
   */
  motAbsent(): boolean {
    return this.jetonNomme && this.token === undefined && this.argIndex === undefined;
  }
}

/**
 * Le pendant de `CliInvalidInput` pour l'arite. Un gestionnaire qui ne
 * peut pas exprimer son minimum par `requireArgs` — parce qu'il depend
 * de laquelle de deux formes positionnelles a ete tapee — le signale
 * plutot que d'ecrire le message lui-meme.
 */
export class CliIncomplete extends Error {
  constructor() {
    super('% Incomplete command.');
    this.name = 'CliIncomplete';
  }
}

export const INVALID_INPUT_MESSAGE = "% Invalid input detected at '^' marker.";
export const INCOMPLETE_MESSAGE = '% Incomplete command.';

export function renderCliDiagnostic(kind: CliErrorKind, ctx: CliDiagnosticContext): string {
  switch (kind) {
    case 'invalid':
      return formatInvalidInput(ctx.tokenOffset ?? ctx.line.trimEnd().length);
    case 'incomplete':
      return INCOMPLETE_MESSAGE;
    case 'ambiguous':
      return `% Ambiguous command:  "${ctx.line.trim()}"`;
    case 'unknown-exec':
      return [
        `Translating "${ctx.token ?? ctx.line.trim()}"...domain server (255.255.255.255)`,
        '% Unknown command or computer name, or unable to find computer address',
      ].join('\n');
  }
}

export interface TokenSpan {
  readonly text: string;
  readonly offset: number;
}

export function tokenSpans(line: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const re = /\S+/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    spans.push({ text: m[0], offset: m.index });
  }
  return spans;
}

export function argumentOffset(
  line: string,
  keywordCount: number,
  argIndex = 0,
): number {
  const spans = tokenSpans(line);
  return spans[keywordCount + argIndex]?.offset
    ?? spans[spans.length - 1]?.offset
    ?? line.trimEnd().length;
}

export function offsetForInvalidInput(
  line: string,
  keywordCount: number,
  error: CliInvalidInput,
): number {
  if (error.token) {
    const found = tokenSpans(line).find(s => s.text.toLowerCase() === error.token!.toLowerCase());
    if (found) return found.offset;
  }
  return argumentOffset(line, keywordCount, error.argIndex ?? 0);
}
