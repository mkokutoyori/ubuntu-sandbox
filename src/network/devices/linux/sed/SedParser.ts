import {
  SedToken, RawAddress, Address, Instruction, SedProgram, SedSyntaxError,
} from './SedAst';
import { compilePosix } from '../regex/PosixRegex';

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

  const compileAddress = (raw: RawAddress, isSecond: boolean): Address => {
    switch (raw.kind) {
      case 'line': return { kind: 'line', line: raw.line };
      case 'last': return { kind: 'last' };
      case 'step': return { kind: 'step', first: raw.first, step: raw.step };
      case 'regex': {
        if (raw.src === '') return { kind: 'regex', reuseLast: true };
        const re = compilePosix(raw.src, {
          extended: opts.extended,
          ignoreCase: raw.flags.includes('I'),
          multiline: raw.flags.includes('M'),
        });
        return { kind: 'regex', re };
      }
      case 'plus':
        if (!isSecond) throw new SedSyntaxError('`+N\' is only valid as a second address');
        return { kind: 'plus', n: raw.n };
      case 'tilde':
        if (!isSecond) throw new SedSyntaxError('`~N\' is only valid as a second address');
        return { kind: 'tilde', n: raw.n };
    }
  };

  while (peek().type !== 'eof') {
    if (peek().type === 'sep') { next(); continue; }

    let addr1: Address | null = null;
    let addr2: Address | null = null;
    let negate = false;

    const t0 = peek();
    if (t0.type === 'addr') {
      addr1 = compileAddress(t0.addr, false);
      next();
      if (peek().type === 'comma') {
        next();
        const t1 = peek();
        if (t1.type !== 'addr') throw new SedSyntaxError('expected address after `,\'');
        addr2 = compileAddress(t1.addr, true);
        next();
      }
    }

    while (peek().type === 'bang') { negate = !negate; next(); }

    const cmd = next();
    const idx = instructions.length;

    switch (cmd.type) {
      case 'lbrace':
        instructions.push({ addr1, addr2, negate, name: '{' });
        blockStack.push(idx);
        break;
      case 'rbrace': {
        instructions.push({ addr1: null, addr2: null, negate: false, name: '}' });
        const open = blockStack.pop();
        if (open === undefined) throw new SedSyntaxError('unexpected `}\'');
        instructions[open].blockEnd = idx;
        break;
      }
      case 'sub': {
        const f = cmd.sub.flags;
        const nthMatch = /\d+/.exec(f);
        const re = cmd.sub.pattern === ''
          ? compilePosix('', { extended: opts.extended })
          : compilePosix(cmd.sub.pattern, {
              extended: opts.extended,
              ignoreCase: /i/i.test(f),
              multiline: /m/i.test(f),
            });
        instructions.push({
          addr1, addr2, negate, name: 's',
          sub: {
            re,
            reuseLast: cmd.sub.pattern === '',
            replacement: cmd.sub.replacement,
            global: f.includes('g'),
            nth: nthMatch ? parseInt(nthMatch[0], 10) : 1,
            print: f.includes('p'),
          },
        });
        break;
      }
      case 'y':
        instructions.push({ addr1, addr2, negate, name: 'y', y: { from: unescapeY(cmd.y.from), to: unescapeY(cmd.y.to) } });
        break;
      case 'text':
        if (cmd.name === ':') {
          if (addr1) throw new SedSyntaxError(': label cannot have an address');
          instructions.push({ addr1: null, addr2: null, negate: false, name: ':', text: cmd.text });
          labels.set(cmd.text, idx);
        } else {
          instructions.push({ addr1, addr2, negate, name: cmd.name, text: cmd.text });
        }
        break;
      case 'quit':
        instructions.push({ addr1, addr2, negate, name: cmd.name, exitCode: cmd.code });
        break;
      case 'op':
        instructions.push({ addr1, addr2, negate, name: cmd.name });
        break;
      default:
        throw new SedSyntaxError('missing command');
    }
  }

  if (blockStack.length > 0) throw new SedSyntaxError('unmatched `{\'');
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
