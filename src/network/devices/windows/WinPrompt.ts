export const DEFAULT_PROMPT = '$P$G';

export interface PromptFacts {
  readonly directory: string;
  readonly stackDepth: number;
  readonly date: string;
  readonly time: string;
  readonly version: string;
  readonly remoteName: string;
}

const CODES: Readonly<Record<string, (facts: PromptFacts) => string>> = {
  q: () => '=',
  $: () => '$',
  t: facts => facts.time,
  d: facts => facts.date,
  p: facts => facts.directory,
  v: facts => facts.version,
  n: facts => facts.directory[0],
  g: () => '>',
  l: () => '<',
  b: () => '|',
  _: () => '\n',
  e: () => '\u001b',
  a: () => '&',
  c: () => '(',
  f: () => ')',
  s: () => ' ',
  '+': facts => '+'.repeat(facts.stackDepth),
  m: facts => facts.remoteName,
};

export function renderPrompt(format: string, facts: PromptFacts): string {
  let out = '';
  for (let index = 0; index < format.length; index++) {
    const character = format[index];
    if (character !== '$') {
      out += character;
      continue;
    }
    const code = format[++index]?.toLowerCase();
    if (code === undefined) break;
    if (code === 'h') out = out.slice(0, -1);
    else out += CODES[code]?.(facts) ?? '';
  }
  return out;
}

export const PROMPT_HELP = [
  'Changes the cmd.exe command prompt.',
  '',
  'PROMPT [text]',
  '',
  '  text    Specifies a new command prompt.',
  '',
  'Prompt can be made up of normal characters and the following special codes:',
  '',
  '  $A   & (Ampersand)',
  '  $B   | (pipe)',
  '  $C   ( (Left parenthesis)',
  '  $D   Current date',
  '  $E   Escape code (ASCII code 27)',
  '  $F   ) (Right parenthesis)',
  '  $G   > (greater-than sign)',
  '  $H   Backspace (erases previous character)',
  '  $L   < (less-than sign)',
  '  $N   Current drive',
  '  $P   Current drive and path',
  '  $Q   = (equal sign)',
  '  $S     (space)',
  '  $T   Current time',
  '  $V   Windows version number',
  '  $_   Carriage return and linefeed',
  '  $$   $ (dollar sign)',
  '',
  'If Command Extensions are enabled the PROMPT command supports',
  'the following additional formatting characters:',
  '',
  '  $+   zero or more plus sign (+) characters depending upon the',
  '       depth of the PUSHD directory stack, one character for each',
  '       level pushed.',
  '',
  '  $M   Displays the remote name associated with the current drive letter or',
  '       the empty string if current drive is not a network drive.',
].join('\n');
