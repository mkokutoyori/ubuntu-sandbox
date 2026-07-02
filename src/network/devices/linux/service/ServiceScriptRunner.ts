export type ScriptStep =
  | { readonly kind: 'command'; readonly command: string }
  | {
      readonly kind: 'conditional';
      readonly condition: string;
      readonly onSuccess: readonly string[];
      readonly onFailure: readonly string[];
    };

export interface ScriptLoop {
  readonly steps: readonly ScriptStep[];
  readonly intervalMs: number;
}

export interface ParsedServiceScript {
  readonly prelude: string;
  readonly loop: ScriptLoop | null;
}

export interface ScriptRunnerHost {
  readFile(path: string): string | null;
  runAsRoot(command: string): Promise<string>;
  runCondition(command: string): Promise<boolean>;
  emitOutput(line: string): void;
  stillCurrent(): boolean;
}

const WHILE_TRUE = /^\s*while\s+(?:true|:)\s*;\s*do\s*$/;
const DONE = /^\s*done\s*$/;
const SLEEP = /^\s*sleep\s+(\d+(?:\.\d+)?)\s*$/;
const IF_COMMAND = /^\s*if\s+(.+?)\s*;\s*then\s*$/;
const ELSE = /^\s*else\s*$/;
const FI = /^\s*fi\s*$/;

const DEFAULT_INTERVAL_SEC = 30;

function parseLoopSteps(lines: readonly string[]): { steps: ScriptStep[]; intervalMs: number } {
  const steps: ScriptStep[] = [];
  let intervalMs = DEFAULT_INTERVAL_SEC * 1000;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const sleep = SLEEP.exec(line);
    if (sleep) {
      intervalMs = parseFloat(sleep[1]) * 1000;
      i++;
      continue;
    }

    const ifCommand = IF_COMMAND.exec(line);
    if (ifCommand) {
      const onSuccess: string[] = [];
      const onFailure: string[] = [];
      let branch = onSuccess;
      i++;
      while (i < lines.length && !FI.test(lines[i])) {
        if (ELSE.test(lines[i])) branch = onFailure;
        else if (lines[i].trim()) branch.push(lines[i].trim());
        i++;
      }
      i++;
      steps.push({ kind: 'conditional', condition: ifCommand[1], onSuccess, onFailure });
      continue;
    }

    steps.push({ kind: 'command', command: line.trim() });
    i++;
  }

  return { steps, intervalMs };
}

export function parseServiceScript(content: string): ParsedServiceScript {
  const lines = content.split('\n');
  const body = lines[0]?.startsWith('#!') ? lines.slice(1) : lines;

  const whileIndex = body.findIndex((line) => WHILE_TRUE.test(line));
  if (whileIndex < 0) {
    return { prelude: body.filter((l) => l.trim()).join('\n'), loop: null };
  }

  let doneIndex = body.length - 1;
  while (doneIndex > whileIndex && !DONE.test(body[doneIndex])) doneIndex--;

  const prelude = body.slice(0, whileIndex).filter((l) => l.trim()).join('\n');
  const { steps, intervalMs } = parseLoopSteps(body.slice(whileIndex + 1, doneIndex));
  return { prelude, loop: { steps, intervalMs } };
}

export class ServiceScriptRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;

  constructor(private readonly host: ScriptRunnerHost) {}

  async start(scriptPath: string): Promise<void> {
    const content = this.host.readFile(scriptPath);
    if (content === null || !content.startsWith('#!')) return;

    const parsed = parseServiceScript(content);
    this.running = true;
    if (parsed.prelude) await this.exec(parsed.prelude);
    if (!parsed.loop || parsed.loop.steps.length === 0) return;

    const loop = parsed.loop;
    void this.runIteration(loop.steps);
    this.timer = setInterval(() => void this.runIteration(loop.steps), loop.intervalMs);
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async runIteration(steps: readonly ScriptStep[]): Promise<void> {
    if (this.ticking || !this.running) return;
    if (!this.host.stillCurrent()) {
      this.stop();
      return;
    }
    this.ticking = true;
    try {
      for (const step of steps) {
        if (!this.running) return;
        if (step.kind === 'command') {
          await this.exec(step.command);
        } else {
          const succeeded = await this.host.runCondition(step.condition);
          const branch = succeeded ? step.onSuccess : step.onFailure;
          if (branch.length > 0) await this.exec(branch.join('\n'));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async exec(script: string): Promise<void> {
    const output = await this.host.runAsRoot(script);
    for (const line of output.split('\n')) {
      if (line.trim()) this.host.emitOutput(line);
    }
  }
}
