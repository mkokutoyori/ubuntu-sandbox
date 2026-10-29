import { SedProgram, Instruction, Address } from './SedAst';
import { substitute } from './SedSubstitute';

export interface SedHost {
  readFile(path: string): string | null;
  appendFile(path: string, content: string): void;
}

export interface SedInput {
  readonly name: string;
  readonly text: string;
}

export interface SedRunOptions {
  quiet: boolean;
  host?: SedHost | null;
  nullData?: boolean;
  lineWrap?: number;
}

interface RangeState {
  active: boolean;
  endLine?: number;
  endedThisLine: boolean;
}

export interface SedResult {
  output: string;
  stderr: string;
  exitCode: number;
}

interface SedLine {
  readonly text: string;
  readonly chomped: boolean;
  readonly file: string;
}

interface PatternSpace {
  text: string;
  chomped: boolean;
}

const STDOUT = '/dev/stdout';
const STDERR = '/dev/stderr';
export const SED_DEFAULT_LINE_WRAP = 70;

class Sink {
  text = '';
  private missingDelimiter = false;

  constructor(private readonly delimiter: string) {}

  pattern(text: string, chomped: boolean): void {
    this.settle();
    this.text += text;
    if (chomped) this.text += this.delimiter;
    else this.missingDelimiter = true;
  }

  raw(text: string): void {
    this.settle();
    this.text += text;
  }

  private settle(): void {
    if (!this.missingDelimiter) return;
    this.text += this.delimiter;
    this.missingDelimiter = false;
  }
}

export function sedWriteTargets(program: SedProgram): string[] {
  const targets = new Set<string>();
  for (const instruction of program.instructions) {
    if ((instruction.name === 'w' || instruction.name === 'W') && instruction.text) targets.add(instruction.text);
    if (instruction.sub?.writeFile) targets.add(instruction.sub.writeFile);
  }
  return [...targets].filter((target) => target !== STDOUT && target !== STDERR);
}

export function runSedProgram(program: SedProgram, inputs: readonly SedInput[], opts: SedRunOptions): SedResult {
  const delimiter = opts.nullData ? '\0' : '\n';
  const lines = splitInputs(inputs, delimiter);
  const { instructions, labels } = program;
  const ranges: RangeState[] = instructions.map((inst) => ({
    active: inst.addr1?.kind === 'line' && inst.addr1.line === 0 && inst.addr2?.kind === 'regex',
    endedThisLine: false,
  }));
  const stdout = new Sink(delimiter);
  const stderr = new Sink(delimiter);
  const files = new Map<string, Sink>();
  const readers = new Map<string, string[]>();
  const host = opts.host ?? null;
  const lineWrap = opts.lineWrap ?? SED_DEFAULT_LINE_WRAP;

  const sinkFor = (path: string): Sink => {
    if (path === STDOUT) return stdout;
    if (path === STDERR) return stderr;
    let sink = files.get(path);
    if (!sink) { sink = new Sink(delimiter); files.set(path, sink); }
    return sink;
  };

  const writeFile = (path: string, ps: PatternSpace, text = ps.text): void => {
    if (path === STDOUT || path === STDERR) { sinkFor(path).pattern(text, ps.chomped); return; }
    const sink = sinkFor(path);
    const before = sink.text.length;
    sink.pattern(text, ps.chomped);
    host?.appendFile(path, sink.text.slice(before));
  };

  let HS: PatternSpace = { text: '', chomped: true };
  let li = 0;
  let lineNo = 0;
  let quit = false;
  let exitCode = 0;
  let lastRegex: RegExp | null = null;
  let currentFile = '-';

  const isLastLine = (): boolean => li >= lines.length;

  const resolveRegex = (a: Address): RegExp | null => {
    const re = a.reuseLast ? lastRegex : (a.re ?? null);
    if (re) lastRegex = re;
    return re;
  };

  const matchSingle = (a: Address, PS: string): boolean => {
    switch (a.kind) {
      case 'line': return lineNo === a.line;
      case 'last': return isLastLine();
      case 'step': return a.step! > 0 ? lineNo >= a.first! && (lineNo - a.first!) % a.step! === 0 : lineNo === a.first;
      case 'regex': { const re = resolveRegex(a); return re ? re.test(PS) : false; }
      default: return false;
    }
  };

  const applies = (inst: Instruction, idx: number, PS: string): boolean => {
    const st = ranges[idx];
    st.endedThisLine = false;
    let result: boolean;
    if (!inst.addr1) {
      result = true;
    } else if (!inst.addr2) {
      result = matchSingle(inst.addr1, PS);
    } else if (!st.active) {
      if (matchSingle(inst.addr1, PS)) {
        st.active = true;
        const a2 = inst.addr2;
        if (a2.kind === 'line') { st.endLine = a2.line; if (a2.line! <= lineNo) { st.active = false; st.endedThisLine = true; } }
        else if (a2.kind === 'plus') { st.endLine = lineNo + a2.n!; if (a2.n === 0) { st.active = false; st.endedThisLine = true; } }
        else if (a2.kind === 'tilde') {
          st.endLine = a2.n! > 0 ? Math.ceil((lineNo + 1) / a2.n!) * a2.n! : lineNo;
          if (st.endLine <= lineNo) { st.active = false; st.endedThisLine = true; }
        }
        else st.endLine = undefined;
        result = true;
      } else {
        result = false;
      }
    } else {
      const a2 = inst.addr2;
      if (a2.kind === 'regex') { const re = resolveRegex(a2); if (re && re.test(PS)) { st.active = false; st.endedThisLine = true; } }
      else if (a2.kind === 'last') { if (isLastLine()) { st.active = false; st.endedThisLine = true; } }
      else if (st.endLine !== undefined && lineNo >= st.endLine) { st.active = false; st.endedThisLine = true; }
      result = true;
    }
    return inst.negate ? !result : result;
  };

  const readerFor = (path: string): string[] => {
    let reader = readers.get(path);
    if (!reader) {
      const text = host?.readFile(path) ?? null;
      reader = text === null || text === '' ? [] : splitRecords(text, delimiter);
      readers.set(path, reader);
    }
    return reader;
  };

  const readLine = (): SedLine => {
    const line = lines[li]; li++; lineNo++;
    currentFile = line.file;
    return line;
  };

  while (li < lines.length && !quit) {
    const first = readLine();
    const PS: PatternSpace = { text: first.text, chomped: first.chomped };
    let tFlag = false;
    let deleted = false;
    const appendQueue: string[] = [];
    let pc = 0;

    const jump = (label: string | undefined): number => (label ? (labels.get(label) ?? instructions.length) : instructions.length);

    while (pc < instructions.length) {
      const inst = instructions[pc];
      if (inst.name === '}' || inst.name === ':') { pc++; continue; }
      const ok = applies(inst, pc, PS.text);
      if (inst.name === '{') { pc = ok ? pc + 1 : inst.blockEnd! + 1; continue; }
      if (!ok) { pc++; continue; }

      switch (inst.name) {
        case 's': {
          const re = inst.sub!.reuseLast ? lastRegex : inst.sub!.re;
          if (re) {
            lastRegex = re;
            const r = substitute(PS.text, re, inst.sub!.replacement, inst.sub!.global, inst.sub!.nth);
            if (r.changed) {
              PS.text = r.result; tFlag = true;
              if (inst.sub!.print) stdout.pattern(PS.text, PS.chomped);
              if (inst.sub!.writeFile) writeFile(inst.sub!.writeFile, PS);
            }
          }
          pc++; break;
        }
        case 'p': stdout.pattern(PS.text, PS.chomped); pc++; break;
        case 'P': {
          const cut = PS.text.indexOf(delimiter);
          stdout.pattern(cut < 0 ? PS.text : PS.text.slice(0, cut), cut < 0 ? PS.chomped : true);
          pc++; break;
        }
        case 'd': deleted = true; pc = instructions.length; break;
        case 'D': {
          const nl = PS.text.indexOf(delimiter);
          if (nl < 0) { deleted = true; pc = instructions.length; }
          else { PS.text = PS.text.slice(nl + 1); pc = 0; }
          break;
        }
        case 'n': {
          if (isLastLine()) { quit = true; pc = instructions.length; break; }
          if (!opts.quiet) stdout.pattern(PS.text, PS.chomped);
          for (const queued of appendQueue.splice(0)) stdout.raw(queued);
          const next = readLine();
          PS.text = next.text; PS.chomped = next.chomped; pc++; break;
        }
        case 'N': {
          if (isLastLine()) { pc = instructions.length; break; }
          for (const queued of appendQueue.splice(0)) stdout.raw(queued);
          const next = readLine();
          PS.text = PS.text + delimiter + next.text; PS.chomped = next.chomped; pc++; break;
        }
        case 'g': PS.text = HS.text; PS.chomped = HS.chomped; pc++; break;
        case 'G': PS.text = PS.text + delimiter + HS.text; PS.chomped = HS.chomped; pc++; break;
        case 'h': HS = { text: PS.text, chomped: PS.chomped }; pc++; break;
        case 'H': HS = { text: HS.text + delimiter + PS.text, chomped: PS.chomped }; pc++; break;
        case 'x': { const t = { text: PS.text, chomped: PS.chomped }; PS.text = HS.text; PS.chomped = HS.chomped; HS = t; pc++; break; }
        case '=': stdout.raw(`${lineNo}${delimiter}`); pc++; break;
        case 'z': PS.text = ''; pc++; break;
        case 'l': stdout.raw(formatL(PS.text, inst.width ?? lineWrap, delimiter)); pc++; break;
        case 'F': stdout.raw(`${currentFile}${delimiter}`); pc++; break;
        case 'y': PS.text = transliterate(PS.text, inst.y!.from, inst.y!.to); pc++; break;
        case 'a': if (!inst.textless) appendQueue.push(`${inst.text ?? ''}\n`); pc++; break;
        case 'i': if (!inst.textless) stdout.raw(`${inst.text ?? ''}\n`); pc++; break;
        case 'c': {
          deleted = true;
          const endsHere = !inst.addr2 || inst.negate || ranges[pc].endedThisLine;
          if (endsHere && !inst.textless) stdout.raw(`${inst.text ?? ''}\n`);
          pc = instructions.length; break;
        }
        case 'r': if (host) { const content = host.readFile(inst.text ?? ''); if (content) appendQueue.push(content); } pc++; break;
        case 'R': {
          const record = readerFor(inst.text ?? '').shift();
          if (record !== undefined) appendQueue.push(record);
          pc++; break;
        }
        case 'w': writeFile(inst.text ?? '', PS); pc++; break;
        case 'W': {
          const cut = PS.text.indexOf(delimiter);
          writeFile(inst.text ?? '', { text: PS.text, chomped: cut < 0 ? PS.chomped : true }, cut < 0 ? PS.text : PS.text.slice(0, cut));
          pc++; break;
        }
        case 'q': quit = true; exitCode = inst.exitCode ?? 0; pc = instructions.length; break;
        case 'Q': quit = true; exitCode = inst.exitCode ?? 0; deleted = true; appendQueue.length = 0; pc = instructions.length; break;
        case 'b': pc = jump(inst.text); break;
        case 't': if (tFlag) { tFlag = false; pc = jump(inst.text); } else pc++; break;
        case 'T': if (!tFlag) { pc = jump(inst.text); } else { tFlag = false; pc++; } break;
        default: pc++; break;
      }
    }

    if (!opts.quiet && !deleted) stdout.pattern(PS.text, PS.chomped);
    for (const a of appendQueue) stdout.raw(a);
  }

  return { output: stdout.text, stderr: stderr.text, exitCode };
}

function splitRecords(text: string, delimiter: string): string[] {
  const records: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(delimiter, from);
    if (at < 0) { if (from < text.length) records.push(text.slice(from)); break; }
    records.push(text.slice(from, at + 1));
    from = at + 1;
  }
  return records;
}

function splitInputs(inputs: readonly SedInput[], delimiter: string): SedLine[] {
  const lines: SedLine[] = [];
  for (const input of inputs) {
    if (input.text === '') continue;
    const parts = input.text.split(delimiter);
    const endsWithDelimiter = input.text.endsWith(delimiter);
    if (endsWithDelimiter) parts.pop();
    parts.forEach((text, index) => {
      lines.push({ text, chomped: endsWithDelimiter || index < parts.length - 1, file: input.name });
    });
  }
  return lines;
}

function transliterate(s: string, from: string, to: string): string {
  const source = [...from];
  const target = [...to];
  let out = '';
  for (const ch of s) {
    const idx = source.indexOf(ch);
    out += idx >= 0 && idx < target.length ? target[idx] : ch;
  }
  return out;
}

const L_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\', '\u0007': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v',
};

function formatL(s: string, lineWrap: number, delimiter: string): string {
  const items: string[] = [];
  for (const ch of s) {
    const escape = L_ESCAPES[ch];
    if (escape) { items.push(escape); continue; }
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) { items.push(ch); continue; }
    items.push(...[...Buffer.from(ch, 'utf8')].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`));
  }
  let out = '';
  let width = 0;
  for (const item of items) {
    if (lineWrap > 0 && width + item.length > lineWrap - 1) { out += '\\\n'; width = 0; }
    out += item;
    width += item.length;
  }
  return `${out}$${delimiter}`;
}
