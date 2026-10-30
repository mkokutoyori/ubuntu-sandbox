import {
  SedToken, RawAddress, Address, Instruction, SedProgram, SedSyntaxError,
} from './SedAst';
import { compilePosix } from '../regex/PosixRegex';
import { PosixRegexError } from '../regex/PosixEre';
import { convertSedRegexEscapes } from './SedEscapes';

export interface SedParseOptions {
  extended: boolean;   // -E / -r
}

export function parseSed(tokens: SedToken[], opts: SedParseOptions): SedProgram {
  let pos = 0;
  const peek = (): SedToken => tokens[pos];
  const next = (): SedToken => tokens[pos++];

  const instructions: Instruction[] = [];
  const labels = new Map<string, number>();
  const blockStack: number[] = [];
  let regexSeen = false;
  const openers: number[] = [];

  const compileRegex = (source: string, flags: { ignoreCase: boolean; multiline: boolean }, at: number): RegExp => {
    try {
      return compilePosix(convertSedRegexEscapes(source), { extended: opts.extended, rightParenIsError: true, ...flags });
    } catch (error) {
      if (error instanceof PosixRegexError) throw new SedSyntaxError(error.message, at);
      throw error;
    }
  };

  const compileAddress = (token: SedToken & { type: 'addr' }, isSecond: boolean): Address => {
    const raw: RawAddress = token.addr;
    switch (raw.kind) {
      case 'line': return { kind: 'line', line: raw.line };
      case 'last': return { kind: 'last' };
      case 'step': return { kind: 'step', first: raw.first, step: raw.step };
      case 'regex': {
        if (raw.src === '') {
          if (!regexSeen) throw new SedSyntaxError('no previous regular expression', 0);
          return { kind: 'regex', reuseLast: true };
        }
        regexSeen = true;
        const re = compileRegex(raw.src, { ignoreCase: raw.flags.includes('I'), multiline: raw.flags.includes('M') }, token.pos);
        return { kind: 'regex', re };
      }
      case 'plus':
        if (!isSecond) throw new SedSyntaxError('invalid usage of +N or ~N as first address', token.pos);
        return { kind: 'plus', n: raw.n };
      case 'tilde':
        if (!isSecond) throw new SedSyntaxError('invalid usage of +N or ~N as first address', token.pos);
        return { kind: 'tilde', n: raw.n };
    }
  };

  const groupCount = (re: RegExp): number => new RegExp(`${re.source}|`, re.flags.replace(/[gy]/g, '')).exec('')!.length - 1;

  while (peek().type !== 'eof') {
    if (peek().type === 'sep') { next(); continue; }

    let addr1: Address | null = null;
    let addr2: Address | null = null;
    let negate = false;

    const t0 = peek();
    if (t0.type === 'addr') {
      addr1 = compileAddress(t0, false);
      next();
      if (peek().type === 'comma') {
        next();
        const t1 = peek();
        if (t1.type !== 'addr') throw new SedSyntaxError("unexpected `,'", Math.min(t1.start + 1, t1.pos));
        addr2 = compileAddress(t1, true);
        next();
      }
    }

    while (peek().type === 'bang') { negate = !negate; next(); }

    const cmd = next();
    const idx = instructions.length;
    const afterLetter = cmd.start + 1;

    const checkAddresses = (name: string) => {
      if (addr1 && addr1.kind === 'line' && addr1.line === 0 && !(addr2 && addr2.kind === 'regex')) {
        throw new SedSyntaxError('invalid usage of line address 0', afterLetter);
      }
      if (addr2 && (name === 'q' || name === 'Q')) throw new SedSyntaxError('command only uses one address', afterLetter);
    };

    switch (cmd.type) {
      case 'lbrace':
        checkAddresses('{');
        instructions.push({ addr1, addr2, negate, name: '{' });
        blockStack.push(idx);
        openers.push(cmd.start);
        break;
      case 'rbrace': {
        const open = blockStack.pop();
        if (open === undefined) throw new SedSyntaxError("unexpected `}'", cmd.start + 1);
        openers.pop();
        if (addr1) throw new SedSyntaxError("} doesn't want any addresses", cmd.start + 1);
        instructions.push({ addr1: null, addr2: null, negate: false, name: '}' });
        instructions[open].blockEnd = idx;
        break;
      }
      case 'sub': {
        checkAddresses('s');
        const f = cmd.sub.flags;
        const nthMatch = /\d+/.exec(f);
        if (cmd.sub.pattern === '' && !regexSeen) throw new SedSyntaxError('no previous regular expression', 0);
        if (cmd.sub.pattern !== '') regexSeen = true;
        const re = cmd.sub.pattern === ''
          ? compilePosix('', { extended: opts.extended })
          : compileRegex(cmd.sub.pattern, { ignoreCase: /[iI]/.test(f), multiline: /[mM]/.test(f) }, cmd.pos);
        if (cmd.sub.pattern !== '') {
          const highest = Math.max(0, ...[...cmd.sub.replacement.matchAll(/\\(\\|\d)/g)].filter((m) => m[1] !== '\\').map((m) => Number(m[1])));
          if (highest > groupCount(re)) {
            throw new SedSyntaxError(`invalid reference \\${highest} on \`s' command's RHS`, cmd.pos);
          }
        }
        instructions.push({
          addr1, addr2, negate, name: 's',
          sub: {
            re,
            reuseLast: cmd.sub.pattern === '',
            replacement: cmd.sub.replacement,
            global: f.includes('g'),
            nth: nthMatch ? parseInt(nthMatch[0], 10) : 1,
            print: f.includes('p'),
            writeFile: cmd.sub.writeFile,
          },
        });
        break;
      }
      case 'y': {
        checkAddresses('y');
        const from = unescapeY(cmd.y.from);
        const to = unescapeY(cmd.y.to);
        if ([...from].length !== [...to].length) throw new SedSyntaxError("strings for `y' command are different lengths", cmd.pos);
        instructions.push({ addr1, addr2, negate, name: 'y', y: { from, to } });
        break;
      }
      case 'text':
        if (cmd.name === ':') {
          if (addr1) throw new SedSyntaxError(": doesn't want any addresses", afterLetter);
          instructions.push({ addr1: null, addr2: null, negate: false, name: ':', text: cmd.text });
          labels.set(cmd.text, idx);
        } else {
          checkAddresses(cmd.name);
          instructions.push({ addr1, addr2, negate, name: cmd.name, text: cmd.text, textless: cmd.textless });
        }
        break;
      case 'quit':
        checkAddresses(cmd.name);
        instructions.push({ addr1, addr2, negate, name: cmd.name, exitCode: cmd.code });
        break;
      case 'op':
        checkAddresses(cmd.name);
        instructions.push({ addr1, addr2, negate, name: cmd.name, width: cmd.width });
        break;
      case 'sep':
        throw new SedSyntaxError(cmd.char === ';' ? "unknown command: `;'" : 'missing command', cmd.pos);
      case 'comma':
        throw new SedSyntaxError("unknown command: `,'", cmd.pos);
      default:
        throw new SedSyntaxError('missing command', cmd.pos);
    }
  }

  if (blockStack.length > 0) throw new SedSyntaxError("unmatched `{'", 0, false, openers[0]);
  for (const instruction of instructions) {
    if ((instruction.name === 'b' || instruction.name === 't' || instruction.name === 'T') && instruction.text && !labels.has(instruction.text)) {
      throw new SedSyntaxError(`can't find label for jump to \`${instruction.text}'`, null, true, null, 4);
    }
  }
  return { instructions, labels };
}

function unescapeY(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      default: return c;
    }
  });
}
