import { CronSchedule } from './CronSchedule';

export interface CrontabEntry {
  schedule: CronSchedule;
  user?: string;
  command: string;
  env: Record<string, string>;
  rawLine: string;
}

export interface ParsedCrontab {
  env: Record<string, string>;
  entries: CrontabEntry[];
  errors: Array<{ line: number; raw: string }>;
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function isMacro(token: string): boolean {
  return token.startsWith('@');
}

export function parseCrontab(content: string, opts: { withUser: boolean }): ParsedCrontab {
  const env: Record<string, string> = {};
  const entries: CrontabEntry[] = [];
  const errors: Array<{ line: number; raw: string }> = [];

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const envMatch = ENV_ASSIGNMENT.exec(line);
    if (envMatch) {
      env[envMatch[1]] = stripQuotes(envMatch[2]);
      continue;
    }

    const tokens = line.split(/\s+/);
    let schedule: CronSchedule | null;
    let rest: string[];
    if (isMacro(tokens[0])) {
      schedule = CronSchedule.parse(tokens[0]);
      rest = tokens.slice(1);
    } else {
      schedule = CronSchedule.parse(tokens.slice(0, 5).join(' '));
      rest = tokens.slice(5);
    }

    if (!schedule) { errors.push({ line: i + 1, raw }); continue; }

    let user: string | undefined;
    if (opts.withUser) {
      user = rest.shift();
      if (!user) { errors.push({ line: i + 1, raw }); continue; }
    }

    const command = rest.join(' ').trim();
    if (command === '') { errors.push({ line: i + 1, raw }); continue; }

    entries.push({ schedule, user, command, env: { ...env }, rawLine: line });
  }

  return { env, entries, errors };
}
