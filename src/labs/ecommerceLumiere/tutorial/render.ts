import type { TutorialPart, TutorialRecord, TutorialRun } from './engine';

const NOISE = [/^Recovery Manager: Release/, /^Copyright \(c\)/];
const ANSI = /\x1b\[[0-9;]*m/g;

function promptOf(record: TutorialRecord): string {
  const { step } = record;
  const host = step.device.toLowerCase();
  if (step.kind === 'sql') return 'SQL> ';
  if (step.kind === 'rman') return 'RMAN> ';
  return step.user === 'oracle' ? `[oracle@${host} ~]$ ` : `[root@${host} ~]# `;
}

function squeeze(text: string): string[] {
  const kept = text.replace(ANSI, '').split('\n').filter((line) => !NOISE.some((pattern) => pattern.test(line.trim())));
  const squeezed: string[] = [];
  for (const line of kept) {
    if (line.trim() === '' && (squeezed.length === 0 || squeezed[squeezed.length - 1].trim() === '')) continue;
    squeezed.push(line.replace(/\s+$/, ''));
  }
  while (squeezed.length > 0 && squeezed[squeezed.length - 1] === '') squeezed.pop();
  return squeezed;
}

function cut(lines: string[], head?: number, tail?: number): string[] {
  if (head === undefined || tail === undefined || lines.length <= head + tail) return lines;
  return [...lines.slice(0, head), `[... ${lines.length - head - tail} lignes omises ...]`, ...lines.slice(lines.length - tail)];
}

function substitute(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(/\$([A-Z]+)/g, (whole, name: string) => variables[name] ?? whole);
}

function shellLines(record: TutorialRecord, part: TutorialPart, prompt: string, variables: Readonly<Record<string, string>>): string[] {
  const input = substitute(part.command, variables).split('\n').map((line, index) => (index === 0 ? `${prompt}${line}` : line));
  return [...input, ...cut(squeeze(part.output), record.step.head, record.step.tail)];
}

export function renderStep(record: TutorialRecord, variables: Readonly<Record<string, string>>): string {
  const prompt = promptOf(record);
  if (record.step.kind === 'shell') {
    return ['```', ...record.parts.flatMap((part) => shellLines(record, part, prompt, variables)), '```'].join('\n');
  }
  const shownInput = record.step.input.split('\n').map((line) => `${prompt}${substitute(line, variables)}`);
  return ['```', ...shownInput, ...cut(squeeze(record.output), record.step.head, record.step.tail), '```'].join('\n');
}

export function renderTutorial(template: string, run: TutorialRun): string {
  const byId = new Map(run.records.map((record) => [record.step.id, record]));
  const withSteps = template.replace(/\{\{step:([a-z0-9-]+)\}\}/g, (_whole, id: string) => {
    const record = byId.get(id);
    if (record === undefined) throw new Error(`template names the step ${id}, which does not exist`);
    return renderStep(record, run.variables);
  });
  return withSteps.replace(/\{\{var:([A-Z]+)\}\}/g, (_whole, name: string) => {
    const value = run.variables[name];
    if (value === undefined) throw new Error(`template names the variable ${name}, which no step captured`);
    return value;
  });
}
