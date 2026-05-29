import { SedProgram, Instruction, Address } from './SedAst';
import { substitute } from './SedSubstitute';

export interface SedHost {
  readFile(path: string): string | null;
  appendFile(path: string, content: string): void;
}

export interface SedRunOptions {
  quiet: boolean;            // -n
  inputEndsNewline: boolean;
  host?: SedHost | null;
}

interface RangeState {
  active: boolean;
  endLine?: number;
  endedThisLine: boolean;
}

export interface SedResult {
  output: string;
  exitCode: number;
}

export function runSedProgram(program: SedProgram, input: string, opts: SedRunOptions): SedResult {
  const lines = splitLines(input);
  const { instructions, labels } = program;
  const ranges: RangeState[] = instructions.map(() => ({ active: false, endedThisLine: false }));
  const out: string[] = [];
  const host = opts.host ?? null;

  let HS = '';
  let li = 0;
  let lineNo = 0;
  let quit = false;
  let exitCode = 0;
  let lastRegex: RegExp | null = null;

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
      const zeroStart = inst.addr1.kind === 'line' && inst.addr1.line === 0;
      if (zeroStart || matchSingle(inst.addr1, PS)) {
        st.active = true;
        const a2 = inst.addr2;
        if (a2.kind === 'line') { st.endLine = a2.line; if (a2.line! <= lineNo) { st.active = false; st.endedThisLine = true; } }
        else if (a2.kind === 'plus') st.endLine = lineNo + a2.n!;
        else if (a2.kind === 'tilde') st.endLine = a2.n! > 0 ? Math.ceil((lineNo + 1) / a2.n!) * a2.n! : lineNo;
        else st.endLine = undefined;
        if (zeroStart && a2.kind === 'regex') { const re = resolveRegex(a2); if (re && re.test(PS)) { st.active = false; st.endedThisLine = true; } }
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

  while (li < lines.length && !quit) {
    let PS = lines[li]; li++; lineNo++;
    let tFlag = false;
    let deleted = false;
    const appendQueue: string[] = [];
    let pc = 0;

    while (pc < instructions.length) {
      const inst = instructions[pc];
      if (inst.name === '}' || inst.name === ':') { pc++; continue; }
      const ok = applies(inst, pc, PS);
      if (inst.name === '{') { pc = ok ? pc + 1 : inst.blockEnd! + 1; continue; }
      if (!ok) { pc++; continue; }

      switch (inst.name) {
        case 's': {
          const re = inst.sub!.reuseLast ? lastRegex : inst.sub!.re;
          if (re) {
            lastRegex = re;
            const r = substitute(PS, re, inst.sub!.replacement, inst.sub!.global, inst.sub!.nth);
            if (r.changed) { PS = r.result; tFlag = true; if (inst.sub!.print) out.push(PS); }
          }
          pc++; break;
        }
        case 'p': out.push(PS); pc++; break;
        case 'P': out.push(PS.split('\n', 1)[0]); pc++; break;
        case 'd': deleted = true; pc = instructions.length; break;
        case 'D': {
          const nl = PS.indexOf('\n');
          if (nl < 0) { deleted = true; pc = instructions.length; }
          else { PS = PS.slice(nl + 1); pc = 0; }
          break;
        }
        case 'n': {
          if (!opts.quiet) out.push(PS);
          if (isLastLine()) { deleted = true; quit = true; pc = instructions.length; break; }
          PS = lines[li]; li++; lineNo++; pc++; break;
        }
        case 'N': {
          if (isLastLine()) { pc = instructions.length; break; }
          PS = PS + '\n' + lines[li]; li++; lineNo++; pc++; break;
        }
        case 'g': PS = HS; pc++; break;
        case 'G': PS = PS + '\n' + HS; pc++; break;
        case 'h': HS = PS; pc++; break;
        case 'H': HS = HS + '\n' + PS; pc++; break;
        case 'x': { const t = PS; PS = HS; HS = t; pc++; break; }
        case '=': out.push(String(lineNo)); pc++; break;
        case 'z': PS = ''; pc++; break;
        case 'l': out.push(formatL(PS)); pc++; break;
        case 'F': out.push('-'); pc++; break;
        case 'y': PS = transliterate(PS, inst.y!.from, inst.y!.to); pc++; break;
        case 'a': appendQueue.push(inst.text ?? ''); pc++; break;
        case 'i': out.push(inst.text ?? ''); pc++; break;
        case 'c': {
          deleted = true;
          const endsHere = !inst.addr2 || ranges[pc].endedThisLine;
          if (endsHere) out.push(inst.text ?? '');
          pc = instructions.length; break;
        }
        case 'r': if (host) appendQueue.push(host.readFile(inst.text ?? '') ?? ''); pc++; break;
        case 'w': if (host) host.appendFile(inst.text ?? '', PS + '\n'); pc++; break;
        case 'q': quit = true; exitCode = inst.exitCode ?? 0; pc = instructions.length; break;
        case 'Q': quit = true; exitCode = inst.exitCode ?? 0; deleted = true; pc = instructions.length; break;
        case 'b': pc = inst.text ? (labels.get(inst.text) ?? instructions.length) : instructions.length; break;
        case 't': if (tFlag) { tFlag = false; pc = inst.text ? (labels.get(inst.text) ?? instructions.length) : instructions.length; } else pc++; break;
        case 'T': if (!tFlag) { pc = inst.text ? (labels.get(inst.text) ?? instructions.length) : instructions.length; } else pc++; break;
        default: pc++; break;
      }
    }

    if (!opts.quiet && !deleted) out.push(PS);
    for (const a of appendQueue) out.push(a);
  }

  let output = out.join('\n');
  if (out.length > 0 && opts.inputEndsNewline) output += '\n';
  return { output, exitCode };
}

function splitLines(input: string): string[] {
  if (input === '') return [];
  const lines = input.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && input.endsWith('\n')) lines.pop();
  return lines;
}

function transliterate(s: string, from: string, to: string): string {
  let out = '';
  for (const ch of s) {
    const idx = from.indexOf(ch);
    out += idx >= 0 && idx < to.length ? to[idx] : ch;
  }
  return out;
}

function formatL(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + '$';
}
