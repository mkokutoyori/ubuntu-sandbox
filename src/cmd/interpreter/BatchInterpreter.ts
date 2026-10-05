import type { BatchHost, CommandOutcome } from '../BatchHost';
import { extractRedirections, isNullDevice, type Redirections } from '../parser/Redirection';
import { splitUnits, stripCarets } from '../parser/Scanner';
import { parseLine, type IfCondition, type Link, type Statement } from '../parser/StatementParser';
import { expandDelayed, expandPercent, substituteLoopVariables, type ExpansionContext } from '../runtime/Expansion';
import { enumerateFor } from '../runtime/ForLoop';
import { executeSet } from '../runtime/SetCommand';

interface Frame {
  readonly units: readonly string[];
  readonly labels: ReadonlyMap<string, number>;
  readonly arguments: string[];
  readonly scriptPath: string | null;
  readonly batch: boolean;
}

interface Run {
  output: string[];
  steps: number;
}

interface Produced {
  readonly lines: string[];
  readonly exitCode: number;
  readonly notRecognized?: boolean;
}

interface LocalState {
  readonly variables: ReadonlyMap<string, string>;
  readonly delayedExpansion: boolean;
}

class GotoSignal { constructor(readonly label: string) {} }
class ExitFrameSignal {}
class ExitShellSignal { constructor(readonly code: number) {} }
class StepLimitSignal {}

const STEP_LIMIT = 200000;
const SYNTAX_ERROR = 'The syntax of the command is incorrect.';
const COMMAND_WORD = /^([A-Za-z]+)(?=$|[\s/:\\,;=(+[\]!]|\.(?<=^echo\.))/i;
const NUMBER = /^[-+]?(0x[0-9a-f]+|\d+)$/i;

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));
const flatten = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim();
const success = (lines: string[] = []): Produced => ({ lines, exitCode: 0 });

function parseArguments(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (const character of text.trim()) {
    if (character === '"') inQuote = !inQuote;
    if (!inQuote && /[\s,;=]/.test(character)) {
      if (current !== '') parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current !== '') parts.push(current);
  return parts;
}

function labelsOf(units: readonly string[]): Map<string, number> {
  const labels = new Map<string, number>();
  units.forEach((unit, index) => {
    const trimmed = unit.trimStart();
    if (!trimmed.startsWith(':') || trimmed.startsWith('::')) return;
    const name = /^:\s*(\S+)/.exec(trimmed)?.[1].toLowerCase();
    if (name !== undefined && !labels.has(name)) labels.set(name, index);
  });
  return labels;
}

function compareValues(left: string, operator: string, right: string, ignoreCase: boolean): boolean {
  let a: number | string = left;
  let b: number | string = right;
  if (NUMBER.test(left) && NUMBER.test(right)) {
    a = Number(left);
    b = Number(right);
  } else if (ignoreCase) {
    a = left.toLowerCase();
    b = right.toLowerCase();
  }
  switch (operator) {
    case 'EQU': return a === b;
    case 'NEQ': return a !== b;
    case 'LSS': return a < b;
    case 'LEQ': return a <= b;
    case 'GTR': return a > b;
    default: return a >= b;
  }
}

export class BatchInterpreter {
  private errorLevel = 0;
  private echoOn = true;
  private delayedExpansion = false;
  private readonly locals: LocalState[] = [];

  constructor(private readonly host: BatchHost) {}

  getErrorLevel(): number { return this.errorLevel; }

  setErrorLevel(value: number): void { this.errorLevel = value; }

  async runLine(text: string): Promise<string> {
    const frame = this.buildFrame([text], null, [], false);
    return this.execute(frame, run => this.runFrame(frame, 0, run));
  }

  async runScript(path: string, args: string[]): Promise<string> {
    const content = this.host.fs.read(path);
    if (content === null) return 'The system cannot find the file specified.';
    const frame = this.buildFrame(content.split('\n'), path, args, true);
    const savedEcho = this.echoOn;
    try {
      return await this.execute(frame, run => this.runFrame(frame, 0, run));
    } finally {
      this.echoOn = savedEcho;
    }
  }

  resolveBatchFile(name: string): string | null {
    const unquoted = name.replace(/^"(.*)"$/, '$1');
    if (unquoted === '') return null;
    const hasExtension = /\.(bat|cmd)$/i.test(unquoted);
    const names = hasExtension ? [unquoted] : [`${unquoted}.bat`, `${unquoted}.cmd`];
    const hasDirectory = /[\\/]/.test(unquoted);
    const searched = hasDirectory
      ? ['']
      : ['', ...(this.host.env.get('PATH') ?? '').split(';').filter(directory => directory !== '')];
    for (const directory of searched) {
      for (const candidate of names) {
        const joined = directory === '' ? candidate : `${directory.replace(/\\$/, '')}\\${candidate}`;
        const absolute = this.host.fs.normalize(joined, this.host.cwd());
        if (this.host.fs.exists(absolute) && !this.host.fs.isDirectory(absolute)) return absolute;
      }
    }
    return null;
  }

  private async execute(frame: Frame, body: (run: Run) => Promise<void>): Promise<string> {
    const run: Run = { output: [], steps: 0 };
    try {
      await body(run);
    } catch (signal) {
      if (signal instanceof ExitShellSignal) this.errorLevel = signal.code;
      else if (signal instanceof StepLimitSignal) run.output.push('The batch file exceeded its step limit and was stopped.');
      else throw signal;
    }
    return run.output.join('\n');
  }

  private buildFrame(lines: readonly string[], scriptPath: string | null, args: string[], batch: boolean): Frame {
    const units = splitUnits(lines);
    return { units, labels: labelsOf(units), arguments: args, scriptPath, batch };
  }

  private async runFrame(frame: Frame, startUnit: number, run: Run): Promise<void> {
    const depth = this.locals.length;
    let index = startUnit;
    try {
      while (index < frame.units.length) {
        const unit = frame.units[index++];
        try {
          await this.runUnit(unit, frame, run);
        } catch (signal) {
          if (signal instanceof ExitFrameSignal) return;
          if (!(signal instanceof GotoSignal)) throw signal;
          const target = frame.labels.get(signal.label);
          if (target === undefined) {
            run.output.push(`The system cannot find the batch label specified - ${signal.label}`);
            this.errorLevel = 1;
            return;
          }
          index = target + 1;
        }
      }
    } finally {
      while (this.locals.length > depth) this.restoreLocal();
    }
  }

  private async runUnit(unit: string, frame: Frame, run: Run): Promise<void> {
    if (unit.trimStart().startsWith(':')) return;
    const expanded = expandPercent(unit, this.expansionContext(frame));
    await this.executeChain(parseLine(expanded), frame, run, frame.batch);
  }

  private async executeChain(links: Link[], frame: Frame, run: Run, echo: boolean): Promise<boolean> {
    let ok = true;
    for (const link of links) {
      if (link.operator === '&&' && !ok) continue;
      if (link.operator === '||' && ok) continue;
      ok = await this.executeStatement(link, frame, run, echo);
    }
    return ok;
  }

  private async runBody(text: string, frame: Frame, run: Run, echo: boolean): Promise<boolean> {
    let ok = true;
    for (const unit of splitUnits(text.split('\n'))) {
      if (unit.trimStart().startsWith(':')) continue;
      ok = await this.executeChain(parseLine(unit), frame, run, echo);
    }
    return ok;
  }

  private tick(run: Run): void {
    run.steps++;
    if (run.steps > STEP_LIMIT) throw new StepLimitSignal();
  }

  private echoCommand(text: string, run: Run): void {
    run.output.push('', `${this.host.cwd()}>${flatten(text)}`);
  }

  private async executeStatement(link: Link, frame: Frame, run: Run, echo: boolean): Promise<boolean> {
    this.tick(run);
    const statement = link.statement;
    const echoes = echo && this.echoOn && link.echoed !== '';
    if (statement.kind === 'simple') return this.executeSimple(statement.text, link.echoed, frame, run, echoes);
    if (echoes) this.echoCommand(link.echoed, run);
    if (statement.kind === 'group') return this.executeGroup(statement, frame, run);
    if (statement.kind === 'if') return this.executeIf(statement, frame, run);
    return this.executeFor(statement, frame, run);
  }

  private async executeGroup(
    statement: Extract<Statement, { kind: 'group' }>, frame: Frame, run: Run,
  ): Promise<boolean> {
    if (statement.suffix === '') return this.runBody(statement.body, frame, run, false);
    const redirections = extractRedirections(statement.suffix);
    const outer = run.output;
    run.output = [];
    let ok = false;
    try {
      ok = await this.runBody(statement.body, frame, run, false);
    } finally {
      const captured = run.output;
      run.output = outer;
      this.route({ lines: captured, exitCode: ok ? 0 : 1 }, redirections, run);
    }
    return ok;
  }

  private async executeIf(
    statement: Extract<Statement, { kind: 'if' }>, frame: Frame, run: Run,
  ): Promise<boolean> {
    const holds = this.evaluate(statement.condition, statement.ignoreCase) !== statement.negate;
    const body = holds ? statement.thenBody : statement.elseBody;
    if (body === null) return true;
    return this.runBody(body, frame, run, false);
  }

  private async executeFor(
    statement: Extract<Statement, { kind: 'for' }>, frame: Frame, run: Run,
  ): Promise<boolean> {
    const iterations = await enumerateFor(this.host, {
      mode: statement.mode, root: statement.root, options: statement.options,
      variable: statement.variable, set: statement.set,
    }, async command => (await this.captureBody(command, frame, run)).join('\n'));
    run.output.push(...iterations.messages);
    const context = this.expansionContext(frame);
    let ok = true;
    for (const bindings of iterations.bindings) {
      const body = substituteLoopVariables(statement.body, bindings, context);
      ok = await this.runBody(body, frame, run, this.echoOn);
    }
    return ok;
  }

  private operand(text: string): string {
    return this.delayedExpansion ? expandDelayed(text, name => this.lookupVariable(name)) : text;
  }

  private evaluate(condition: IfCondition, ignoreCase: boolean): boolean {
    switch (condition.kind) {
      case 'exist': return this.exists(this.operand(condition.operand).replace(/^"(.*)"$/, '$1'));
      case 'defined': return this.lookupVariable(this.operand(condition.operand)) !== undefined;
      case 'errorlevel': return this.errorLevel >= Number(this.operand(condition.operand));
      case 'cmdextversion': return 2 >= Number(this.operand(condition.operand));
      case 'equals': {
        const left = this.operand(condition.left);
        const right = this.operand(condition.right);
        return ignoreCase ? left.toLowerCase() === right.toLowerCase() : left === right;
      }
      case 'compare':
        return compareValues(this.operand(condition.left), condition.operator, this.operand(condition.right), ignoreCase);
    }
  }

  private exists(path: string): boolean {
    if (!/[*?]/.test(path)) return this.host.fs.exists(this.host.fs.normalize(path, this.host.cwd()));
    const separator = path.lastIndexOf('\\');
    const directory = this.host.fs.normalize(separator < 0 ? this.host.cwd() : path.slice(0, separator + 1), this.host.cwd());
    const pattern = new RegExp(`^${path.slice(separator + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    return this.host.fs.list(directory).some(entry => pattern.test(entry.name));
  }

  private lookupVariable(name: string): string | undefined {
    switch (name.toUpperCase()) {
      case 'ERRORLEVEL': return String(this.errorLevel);
      case 'DATE': return this.host.formattedDate();
      case 'TIME': return this.host.formattedTime();
      case 'RANDOM': return String(this.host.random());
      case 'CD': return this.host.cwd().replace(/^([A-Za-z]:)\\$/, '$1\\');
      case 'CMDEXTVERSION': return '2';
      default: return this.host.env.get(name);
    }
  }

  private expansionContext(frame: Frame): ExpansionContext {
    return {
      batch: frame.batch,
      arguments: frame.arguments,
      scriptPath: frame.scriptPath,
      lookup: name => this.lookupVariable(name),
      absolute: path => this.host.fs.normalize(path, this.host.cwd()),
      factsOf: absolute => {
        const separator = absolute.lastIndexOf('\\');
        const parent = separator <= 2 ? absolute.slice(0, separator + 1) : absolute.slice(0, separator);
        const found = this.host.fs.list(parent).find(entry => entry.name.toLowerCase() === absolute.slice(separator + 1).toLowerCase());
        return found === undefined ? null : found;
      },
    };
  }

  private async executeSimple(
    text: string, echoed: string, frame: Frame, run: Run, echoes: boolean,
  ): Promise<boolean> {
    if (echoes) this.echoCommand(echoed, run);
    const source = this.delayedExpansion ? expandDelayed(text, name => this.lookupVariable(name)) : text;
    const redirections = extractRedirections(source);
    const command = stripCarets(redirections.command).trim();
    const produced = command === '' ? success() : await this.dispatch(command, redirections, frame, run);
    this.route(produced, redirections, run);
    return produced.exitCode === 0;
  }

  private route(produced: Produced, redirections: Redirections, run: Run): void {
    const failed = produced.exitCode !== 0;
    let standardOutput = failed ? [] : produced.lines;
    let standardError = failed ? produced.lines : [];
    if (redirections.stderrToStdout) { standardOutput = [...standardOutput, ...standardError]; standardError = []; }
    if (redirections.stdoutToStderr) { standardError = [...standardOutput, ...standardError]; standardOutput = []; }
    this.deliver(standardOutput, redirections.stdout, run);
    this.deliver(standardError, redirections.stderr, run);
  }

  private deliver(lines: string[], target: Redirections['stdout'], run: Run): void {
    if (target === null) { run.output.push(...lines); return; }
    if (isNullDevice(target.path)) return;
    const content = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    const absolute = this.host.fs.normalize(target.path, this.host.cwd());
    if (!this.host.fs.write(absolute, content, target.append)) {
      run.output.push('The system cannot find the path specified.');
      this.errorLevel = 1;
    }
  }

  private async dispatch(command: string, redirections: Redirections, frame: Frame, run: Run): Promise<Produced> {
    const match = COMMAND_WORD.exec(command);
    const word = match?.[1].toLowerCase() ?? '';
    const rest = match === null ? command : command.slice(match[0].length);
    switch (word) {
      case 'echo': return this.echoBuiltin(rest);
      case 'rem': return success();
      case 'set': return this.setBuiltin(rest, frame);
      case 'goto': return this.gotoBuiltin(rest);
      case 'call': return this.callBuiltin(rest, frame, run);
      case 'exit': return this.exitBuiltin(rest);
      case 'shift': frame.arguments.shift(); return success();
      case 'setlocal': return this.setlocalBuiltin(rest);
      case 'endlocal': this.restoreLocal(); return success();
      default: return this.runExternal(command, redirections, frame, run);
    }
  }

  private echoBuiltin(rest: string): Produced {
    const delimiter = rest[0];
    const text = delimiter === ' ' || delimiter === '.' || delimiter === ':' ? rest.slice(1) : rest;
    if (delimiter === '.' || delimiter === ':') return success([text]);
    const lowered = text.trim().toLowerCase();
    if (lowered === 'on' || lowered === 'off') {
      this.echoOn = lowered === 'on';
      return success();
    }
    if (text.trim() === '') return success([`ECHO is ${this.echoOn ? 'on' : 'off'}.`]);
    return success([text]);
  }

  private async setBuiltin(rest: string, frame: Frame): Promise<Produced> {
    const outcome = await executeSet(this.host, rest, { printsResult: !frame.batch });
    if (outcome.exitCode !== 0) this.errorLevel = outcome.exitCode;
    return { lines: linesOf(outcome.output), exitCode: outcome.exitCode };
  }

  private gotoBuiltin(rest: string): Produced {
    const label = rest.trim().split(/[\s/]/)[0].replace(/^:/, '');
    if (label === '') return { lines: [SYNTAX_ERROR], exitCode: 1 };
    if (label.toLowerCase() === 'eof') throw new ExitFrameSignal();
    throw new GotoSignal(label.toLowerCase());
  }

  private exitBuiltin(rest: string): Produced {
    const match = /^\s*(\/b)?\s*(-?\d+)?/i.exec(rest);
    const code = match?.[2] === undefined ? this.errorLevel : Number(match[2]);
    this.errorLevel = code;
    if (match?.[1] !== undefined) throw new ExitFrameSignal();
    throw new ExitShellSignal(code);
  }

  private setlocalBuiltin(rest: string): Produced {
    const snapshot = new Map<string, string>();
    for (const name of this.host.env.names()) snapshot.set(name, this.host.env.get(name) ?? '');
    this.locals.push({ variables: snapshot, delayedExpansion: this.delayedExpansion });
    const option = rest.trim().toLowerCase();
    if (option === 'enabledelayedexpansion') this.delayedExpansion = true;
    if (option === 'disabledelayedexpansion') this.delayedExpansion = false;
    return success();
  }

  private restoreLocal(): void {
    const saved = this.locals.pop();
    if (saved === undefined) return;
    for (const name of this.host.env.names()) {
      if (!saved.variables.has(name)) this.host.env.unset(name);
    }
    for (const [name, value] of saved.variables) {
      if (this.host.env.get(name) !== value) this.host.env.set(name, value);
    }
    this.delayedExpansion = saved.delayedExpansion;
  }

  private async callBuiltin(rest: string, frame: Frame, run: Run): Promise<Produced> {
    const target = rest.trim();
    if (target === '') return { lines: [SYNTAX_ERROR], exitCode: 1 };
    const [first, ...others] = parseArguments(target);
    if (first.startsWith(':')) {
      const label = first.slice(1).toLowerCase();
      const index = frame.labels.get(label);
      if (index === undefined) {
        return { lines: [`The system cannot find the batch label specified - ${label}`], exitCode: 1 };
      }
      await this.runFrame({ ...frame, arguments: others }, index + 1, run);
      return { lines: [], exitCode: this.errorLevel };
    }
    const script = this.resolveBatchFile(first);
    if (script !== null) return this.invokeScript(script, others, frame, run, true);
    const reexpanded = expandPercent(target, this.expansionContext(frame));
    const captured = await this.captureBody(reexpanded, frame, run);
    return { lines: captured, exitCode: this.errorLevel };
  }

  private async captureBody(text: string, frame: Frame, run: Run): Promise<string[]> {
    const outer = run.output;
    run.output = [];
    let captured: string[] = [];
    try {
      await this.runBody(text, frame, run, false);
    } finally {
      captured = run.output;
      run.output = outer;
    }
    return captured;
  }

  private async invokeScript(
    path: string, args: string[], frame: Frame, run: Run, viaCall: boolean,
  ): Promise<Produced> {
    const content = this.host.fs.read(path);
    if (content === null) return { lines: ['The system cannot find the file specified.'], exitCode: 1 };
    const scriptFrame = this.buildFrame(content.split('\n'), path, args, true);
    const savedEcho = this.echoOn;
    const outer = run.output;
    run.output = [];
    let captured: string[] = [];
    try {
      await this.runFrame(scriptFrame, 0, run);
    } finally {
      captured = run.output;
      run.output = outer;
      this.echoOn = savedEcho;
    }
    if (!viaCall && frame.batch) {
      run.output.push(...captured);
      throw new ExitFrameSignal();
    }
    return { lines: captured, exitCode: this.errorLevel };
  }

  private async runExternal(command: string, redirections: Redirections, frame: Frame, run: Run): Promise<Produced> {
    const firstWord = parseArguments(command)[0] ?? '';
    if (/\.(bat|cmd)$/i.test(firstWord.replace(/^"|"$/g, ''))) {
      const script = this.resolveBatchFile(firstWord);
      if (script !== null) return this.invokeScript(script, parseArguments(command).slice(1), frame, run, false);
    }
    let line = command;
    if (redirections.stdin !== null) line = `type "${redirections.stdin}" | ${command}`;
    const outcome: CommandOutcome = await this.host.runCommand(line);
    if (outcome.notRecognized === true) {
      const script = this.resolveBatchFile(firstWord);
      if (script !== null) return this.invokeScript(script, parseArguments(command).slice(1), frame, run, false);
    }
    this.errorLevel = outcome.exitCode;
    return { lines: linesOf(outcome.output), exitCode: outcome.exitCode };
  }
}

