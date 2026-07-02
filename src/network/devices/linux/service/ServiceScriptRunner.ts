export interface ParsedServiceScript {
  readonly prelude: string;
  readonly loop: { readonly body: string; readonly intervalMs: number } | null;
}

export interface ScriptRunnerHost {
  readFile(path: string): string | null;
  runAsRoot(command: string): Promise<string>;
  emitOutput(line: string): void;
  stillCurrent(): boolean;
}

const WHILE_TRUE = /^\s*while\s+(?:true|:)\s*;\s*do\s*$/;
const DONE = /^\s*done\s*$/;
const SLEEP = /^\s*sleep\s+(\d+(?:\.\d+)?)\s*$/;

const DEFAULT_INTERVAL_SEC = 30;

export function parseServiceScript(content: string): ParsedServiceScript {
  const lines = content.split('\n');
  const source = lines[0]?.startsWith('#!') ? lines.slice(1) : lines;

  const whileIndex = source.findIndex((line) => WHILE_TRUE.test(line));
  if (whileIndex < 0) {
    return { prelude: source.filter((l) => l.trim()).join('\n'), loop: null };
  }

  let doneIndex = source.length - 1;
  while (doneIndex > whileIndex && !DONE.test(source[doneIndex])) doneIndex--;

  const prelude = source.slice(0, whileIndex).filter((l) => l.trim()).join('\n');
  const bodyLines: string[] = [];
  let intervalMs = DEFAULT_INTERVAL_SEC * 1000;
  for (const line of source.slice(whileIndex + 1, doneIndex)) {
    const sleep = SLEEP.exec(line);
    if (sleep) {
      intervalMs = parseFloat(sleep[1]) * 1000;
      continue;
    }
    if (line.trim()) bodyLines.push(line);
  }
  return { prelude, loop: { body: bodyLines.join('\n'), intervalMs } };
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
    if (!parsed.loop || !parsed.loop.body) return;

    const loop = parsed.loop;
    void this.runIteration(loop.body);
    this.timer = setInterval(() => void this.runIteration(loop.body), loop.intervalMs);
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async runIteration(body: string): Promise<void> {
    if (this.ticking || !this.running) return;
    if (!this.host.stillCurrent()) {
      this.stop();
      return;
    }
    this.ticking = true;
    try {
      await this.exec(body);
    } finally {
      this.ticking = false;
    }
  }

  private async exec(script: string): Promise<void> {
    const output = await this.host.runAsRoot(script);
    if (!this.running) return;
    for (const line of output.split('\n')) {
      if (line.trim()) this.host.emitOutput(line);
    }
  }
}
