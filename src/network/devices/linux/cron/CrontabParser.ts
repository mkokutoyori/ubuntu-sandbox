import { CronSchedule, type ScheduleField } from './CronSchedule';

export interface CrontabEntry {
  schedule: CronSchedule;
  user?: string;
  command: string;
  env: Record<string, string>;
  rawLine: string;
}

/**
 * Une ligne refusée, avec ce que Vixie cron en dirait : `bad minute`,
 * `bad day-of-week`, `bad command`. Le parseur relevait déjà les lignes
 * fautives ; il dit maintenant pourquoi, ce qui est ce qu'il faut pour
 * que `crontab` refuse d'installer en le motivant.
 */
export interface CrontabError {
  line: number;
  raw: string;
  reason: `bad ${ScheduleField}` | 'bad command';
}

export interface ParsedCrontab {
  env: Record<string, string>;
  entries: CrontabEntry[];
  errors: CrontabError[];
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
  const errors: CrontabError[] = [];

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
    const macro = isMacro(tokens[0]);
    const parsed = CronSchedule.parseDetailed(
      macro ? tokens[0] : tokens.slice(0, 5).join(' '));
    const rest = macro ? tokens.slice(1) : tokens.slice(5);

    if (!(parsed instanceof CronSchedule)) {
      errors.push({ line: i + 1, raw, reason: `bad ${parsed}` });
      continue;
    }

    let user: string | undefined;
    if (opts.withUser) {
      user = rest.shift();
      if (!user) { errors.push({ line: i + 1, raw, reason: 'bad command' }); continue; }
    }

    const command = rest.join(' ').trim();
    if (command === '') { errors.push({ line: i + 1, raw, reason: 'bad command' }); continue; }

    entries.push({ schedule: parsed, user, command, env: { ...env }, rawLine: line });
  }

  return { env, entries, errors };
}
