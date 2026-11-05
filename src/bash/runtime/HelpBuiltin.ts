import { globToRegexSource } from '@/network/devices/linux/fs/Glob';
import { HELP_OVERVIEW, HELP_TOPICS, type HelpTopic } from './BuiltinHelpTopics';

const HELP_USAGE = 'help: usage: help [-dms] [pattern ...]\n';

interface HelpResult {
  readonly output: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

type HelpForm = 'long' | 'description' | 'synopsis' | 'manual';

function isGlobPattern(pattern: string): boolean {
  return /[*?\\]|[@+!]\(|\[.*\]/.test(pattern);
}

function topicsMatching(pattern: string): readonly HelpTopic[] {
  const matcher = new RegExp(`^(?:${globToRegexSource(pattern, true)})$`, 's');
  const exact = HELP_TOPICS.filter((topic) => topic.name === pattern);
  if (exact.length > 0) return exact;
  return HELP_TOPICS.filter((topic) => topic.name.startsWith(pattern) || matcher.test(topic.name));
}

function rendered(topic: HelpTopic, form: HelpForm): string {
  if (form === 'description') return `${topic.description}\n`;
  if (form === 'synopsis') return `${topic.synopsis}\n`;
  return form === 'manual' ? topic.manual : topic.long;
}

export function builtinHelp(args: readonly string[]): HelpResult {
  const letters = new Set<string>();
  let index = 0;
  for (; index < args.length; index++) {
    const word = args[index];
    if (word === '--') { index++; break; }
    if (!word.startsWith('-') || word === '-') break;
    for (const letter of word.slice(1)) {
      if ('dms'.includes(letter)) letters.add(letter);
      else return { output: '', stderr: `bash: help: -${letter}: invalid option\n${HELP_USAGE}`, exitCode: 2 };
    }
  }
  const form: HelpForm = letters.has('d') ? 'description' : letters.has('m') ? 'manual' : letters.has('s') ? 'synopsis' : 'long';
  const patterns = args.slice(index);
  if (patterns.length === 0) return { output: HELP_OVERVIEW, exitCode: 0 };
  let output = '';
  let found = false;
  if (isGlobPattern(patterns[0])) output += `Shell commands matching keyword${patterns.length > 1 ? 's' : ''} \`${patterns.join(', ')}'\n\n`;
  for (const pattern of patterns) {
    const matches = topicsMatching(pattern);
    if (matches.length === 0) continue;
    found = true;
    for (const topic of matches) output += rendered(topic, form);
  }
  if (found) return { output, exitCode: 0 };
  const last = patterns[patterns.length - 1];
  return { output, stderr: `bash: help: no help topics match \`${last}'.  Try \`help help' or \`man -k ${last}' or \`info ${last}'.\n`, exitCode: 1 };
}
