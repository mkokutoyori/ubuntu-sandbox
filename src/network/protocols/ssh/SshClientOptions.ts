import { splitShellWords } from '@/bash/runtime/ShellWords';
import type { SshClientKeyword } from './SshClientKeywords';

const OPTION_ALIASES: Readonly<Record<string, string>> = {
  challengeresponseauthentication: 'kbdinteractiveauthentication',
  skeyauthentication: 'kbdinteractiveauthentication',
  tisauthentication: 'kbdinteractiveauthentication',
  dsaauthentication: 'pubkeyauthentication',
  keepalive: 'tcpkeepalive',
  identityfile2: 'identityfile',
};

const OPTION_LINE = /^([^\s=]+)\s*(?:=\s*)?([\s\S]*)$/;

export interface SshOptionAssignment {
  readonly name: string;
  readonly value: string;
}

export function sshOptionAssignment(raw: string): SshOptionAssignment | null {
  const match = OPTION_LINE.exec(raw.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { name: OPTION_ALIASES[name] ?? name, value: match[2].trim() };
}

export function sshFlag(value: string): boolean | null {
  const lowered = value.toLowerCase();
  if (lowered === 'yes' || lowered === 'true') return true;
  if (lowered === 'no' || lowered === 'false') return false;
  return null;
}

export function firstSshOption(optionValues: readonly string[], keyword: string): string | undefined {
  for (const raw of optionValues) {
    const assignment = sshOptionAssignment(raw);
    if (assignment?.name === keyword) return assignment.value;
  }
  return undefined;
}

export function everySshOption(optionValues: readonly string[], keyword: string): string[] {
  const values: string[] = [];
  for (const raw of optionValues) {
    const assignment = sshOptionAssignment(raw);
    if (assignment?.name === keyword) values.push(assignment.value);
  }
  return values;
}

export function sshOptionRefusal(raw: string, keywords: readonly SshClientKeyword[]): string | null {
  const line = raw.trim();
  if (line === '') return null;
  const match = OPTION_LINE.exec(line);
  if (!match) return null;
  const keyword = match[1].toLowerCase();
  const rest = match[2].trim();
  if (rest === '') return `command-line line 0: no argument after keyword "${keyword}"`;

  const known = keywords.find(entry => entry.name.toLowerCase() === keyword);
  if (known === undefined) return `command-line: line 0: Bad configuration option: ${keyword}`;
  if (known.refusal !== undefined) return known.refusal;
  if (known.values === undefined) return null;

  const [argument, ...extra] = splitShellWords(rest).words;
  if (argument === undefined || !known.values.includes(argument.toLowerCase())) {
    return `command-line line 0: unsupported option "${argument ?? ''}".`;
  }
  return extra.length > 0
    ? `command-line line 0: keyword ${keyword} extra arguments at end of line`
    : null;
}

export function sshOptionCompletionWords(keywords: readonly SshClientKeyword[]): string[] {
  return keywords.filter(entry => entry.hidden !== true).map(entry => `${entry.name}=`);
}
