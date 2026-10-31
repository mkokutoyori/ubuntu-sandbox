import { splitShellWords } from '@/bash/runtime/ShellWords';
import { DEFAULT_LESS_OPTIONS, type LessOptions } from './LessEngine';

export interface LessLaunch {
  readonly files: readonly string[];
  readonly options: LessOptions;
  readonly quitIfOneScreen: boolean;
  readonly initialKeys: string;
  readonly help: boolean;
  readonly piped: boolean;
  readonly prefix: string;
}

export type LessParse =
  | { readonly kind: 'open'; readonly launch: LessLaunch }
  | { readonly kind: 'print'; readonly lines: readonly string[] }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'none' };

export const LESS_VERSION_LINES: readonly string[] = [
  'less 590 (GNU regular expressions)',
  'Copyright (C) 1984-2021  Mark Nudelman',
  '',
  'less comes with NO WARRANTY, to the extent permitted by law.',
  'For information about the terms of redistribution,',
  'see the file named README in the less distribution.',
  'Home page: https://greenwoodsoftware.com/less',
];

const IGNORED_FLAGS = new Set(['X', 'R', 'r', 'E', 'e', 'M', 'm', 'q', 's', 'n', 'c', 'C', 'K', 'w', 'g', 'a', 'f', 'L', 'u', 'U', 'V', 'Q']);

function lastTopLevelPipe(commandLine: string): number {
  let quote: string | null = null;
  let last = -1;
  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '|' && commandLine[i + 1] !== '|' && commandLine[i - 1] !== '|') {
      last = i;
    }
  }
  return last;
}

export function parseLessLaunch(commandLine: string): LessParse {
  const trimmed = commandLine.trim();
  const pipe = lastTopLevelPipe(trimmed);
  const piped = pipe >= 0;
  const prefix = piped ? trimmed.slice(0, pipe).trim() : '';
  const own = piped ? trimmed.slice(pipe + 1).trim() : trimmed;
  const noSudo = own.startsWith('sudo ') ? own.slice(5).trimStart() : own;
  const words = splitShellWords(noSudo).words;
  if (words[0] !== 'less') return { kind: 'none' };
  if (piped && prefix === '') return { kind: 'none' };
  if (/[;&<>]/.test(noSudo.replace(/'[^']*'|"[^"]*"/g, ''))) return { kind: 'none' };

  let options = DEFAULT_LESS_OPTIONS;
  let quitIfOneScreen = false;
  let help = false;
  let initialKeys = '';
  const files: string[] = [];
  let endOfOptions = false;
  for (const word of words.slice(1)) {
    if (endOfOptions || !(word.startsWith('-') || word.startsWith('+')) || word === '-') {
      files.push(word);
    } else if (word === '--') {
      endOfOptions = true;
    } else if (word.startsWith('+')) {
      const command = word.slice(1);
      if (command === 'F') quitIfOneScreen = true;
      else if (command.startsWith('/')) initialKeys += `${command}\n`;
      else if (/^\d+$/.test(command)) initialKeys += `${command}g`;
      else initialKeys += command;
    } else if (word.startsWith('--')) {
      const name = word.slice(2).split('=')[0];
      if (name === 'line-numbers') options = { ...options, lineNumbers: true };
      else if (name === 'chop-long-lines') options = { ...options, chopLongLines: true };
      else if (name === 'ignore-case') options = { ...options, ignoreCase: true };
      else if (name === 'IGNORE-CASE') options = { ...options, ignoreCaseAlways: true };
      else if (name === 'quit-if-one-screen') quitIfOneScreen = true;
      else if (name === 'version') return { kind: 'print', lines: LESS_VERSION_LINES };
      else if (name === 'help') help = true;
      else if (!['RAW-CONTROL-CHARS', 'no-init', 'quiet', 'silent', 'squeeze-blank-lines', 'LONG-PROMPT', 'long-prompt'].includes(name)) {
        return { kind: 'error', message: `There is no --${name} option ("less --help" for help)` };
      }
    } else {
      for (const letter of word.slice(1)) {
        if (letter === 'N') options = { ...options, lineNumbers: true };
        else if (letter === 'S') options = { ...options, chopLongLines: true };
        else if (letter === 'i') options = { ...options, ignoreCase: true };
        else if (letter === 'I') options = { ...options, ignoreCaseAlways: true };
        else if (letter === 'F') quitIfOneScreen = true;
        else if (letter === 'V') return { kind: 'print', lines: LESS_VERSION_LINES };
        else if (letter === '?') help = true;
        else if (!IGNORED_FLAGS.has(letter)) {
          return { kind: 'error', message: `There is no ${letter} option ("less --help" for help)` };
        }
      }
    }
  }
  return { kind: 'open', launch: { files, options, quitIfOneScreen, initialKeys, help, piped, prefix } };
}
