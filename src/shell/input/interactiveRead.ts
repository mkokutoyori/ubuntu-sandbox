import type { InputBroker } from './InputBroker';

export interface ParsedRead {
  readonly silent: boolean;
  readonly prompt: string | null;
  readonly vars: readonly string[];
}

export function parseReadInvocation(line: string): ParsedRead | null {
  const tokens = tokenize(line);
  if (tokens.length === 0 || tokens[0] !== 'read') return null;
  let silent = false;
  let prompt: string | null = null;
  const vars: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-r') continue;
    if (t === '-s') { silent = true; continue; }
    if (t === '-p' && i + 1 < tokens.length) { prompt = tokens[++i]; continue; }
    if (t.startsWith('-p')) { prompt = t.slice(2); continue; }
    if (t.startsWith('-')) return null;
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(t)) return null;
    vars.push(t);
  }
  return { silent, prompt, vars };
}

export interface InteractiveReadOutcome {
  readonly handled: boolean;
  readonly cancelled?: boolean;
  readonly value?: string;
  readonly bindings?: ReadonlyArray<{ name: string; value: string }>;
}

export async function performInteractiveRead(
  broker: InputBroker,
  parsed: ParsedRead,
  opts: { ifs?: string } = {},
): Promise<InteractiveReadOutcome> {
  const prompt = parsed.prompt ?? '';
  const value = parsed.silent
    ? await broker.password(prompt, { trim: false })
    : await broker.ask(prompt, { trim: false });
  if (value === null) return { handled: true, cancelled: true };

  const targets = parsed.vars.length ? parsed.vars : ['REPLY'];
  if (targets.length === 1) {
    return { handled: true, value, bindings: [{ name: targets[0], value }] };
  }
  const ifs = opts.ifs ?? ' \t\n';
  const splitter = new RegExp(`[${ifs.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')}]+`);
  const parts = value.split(splitter).filter(Boolean);
  const bindings: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < targets.length; i++) {
    if (i === targets.length - 1) bindings.push({ name: targets[i], value: parts.slice(i).join(' ') });
    else bindings.push({ name: targets[i], value: parts[i] ?? '' });
  }
  return { handled: true, value, bindings };
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < line.length) { buf += line[++i]; continue; }
      buf += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ' ' || c === '\t') { if (buf) { out.push(buf); buf = ''; } continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}
