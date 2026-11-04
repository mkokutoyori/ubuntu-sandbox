import { bytesToHex } from '@/crypto/encoding';
import { blake2b, md5, sha1, sha224, sha256, sha384, sha512, sm3 } from '@/crypto/hash';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { argumentFailure, matchArgument } from './BackupControl';
import { InputQueue, Streams, docsResult, fromBytes, quoteLocale, quotef, readFailureText, toBytes, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'algorithm', letter: 'a', takesArgument: true },
  { name: 'binary', letter: 'b', takesArgument: false },
  { name: 'check', letter: 'c', takesArgument: false },
  { name: 'debug', letter: 'D', takesArgument: false },
  { name: 'ignore-missing', letter: 'I', takesArgument: false },
  { name: 'length', letter: 'l', takesArgument: true },
  { name: 'quiet', letter: 'q', takesArgument: false },
  { name: 'raw', letter: 'R', takesArgument: false },
  { name: 'status', letter: 'S', takesArgument: false },
  { name: 'strict', letter: 'T', takesArgument: false },
  { name: 'tag', letter: 'G', takesArgument: false },
  { name: 'text', letter: 't', takesArgument: false },
  { name: 'untagged', letter: 'U', takesArgument: false },
  { name: 'warn', letter: 'w', takesArgument: false },
  { name: 'zero', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

type Algorithm = 'bsd' | 'sysv' | 'crc' | 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512' | 'blake2b' | 'sm3';

const ALGORITHMS: readonly (readonly [string, Algorithm])[] = [
  ['bsd', 'bsd'], ['sysv', 'sysv'], ['crc', 'crc'], ['md5', 'md5'], ['sha1', 'sha1'], ['sha224', 'sha224'],
  ['sha256', 'sha256'], ['sha384', 'sha384'], ['sha512', 'sha512'], ['blake2b', 'blake2b'], ['sm3', 'sm3'],
];

const TAGS: Readonly<Record<Algorithm, string>> = {
  bsd: 'BSD', sysv: 'SYSV', crc: 'CRC', md5: 'MD5', sha1: 'SHA1', sha224: 'SHA224', sha256: 'SHA256',
  sha384: 'SHA384', sha512: 'SHA512', blake2b: 'BLAKE2b', sm3: 'SM3',
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit++) value = (value & 0x80000000) !== 0 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    table[index] = value >>> 0;
  }
  return table;
})();

function posixCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  let length = bytes.length;
  while (length > 0) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ (length & 0xff)) & 0xff]) >>> 0;
    length = Math.floor(length / 256);
  }
  return (~crc) >>> 0;
}

function bsdSum(bytes: Uint8Array): number {
  let checksum = 0;
  for (const byte of bytes) {
    checksum = ((checksum >>> 1) + ((checksum & 1) << 15)) & 0xffff;
    checksum = (checksum + byte) & 0xffff;
  }
  return checksum;
}

function sysvSum(bytes: Uint8Array): number {
  let sum = 0;
  for (const byte of bytes) sum += byte;
  const folded = (sum & 0xffff) + ((sum & 0xffffffff) >>> 16);
  return ((folded & 0xffff) + (folded >>> 16)) & 0xffff;
}

function digestHex(algorithm: Algorithm, bytes: Uint8Array, bits: number): string {
  switch (algorithm) {
    case 'md5': return bytesToHex(md5(bytes));
    case 'sha1': return bytesToHex(sha1(bytes));
    case 'sha224': return bytesToHex(sha224(bytes));
    case 'sha256': return bytesToHex(sha256(bytes));
    case 'sha384': return bytesToHex(sha384(bytes));
    case 'sha512': return bytesToHex(sha512(bytes));
    case 'blake2b': return bytesToHex(blake2b(bytes, bits / 8));
    default: return bytesToHex(sm3(bytes));
  }
}

const isDigest = (algorithm: Algorithm): boolean => !['bsd', 'sysv', 'crc'].includes(algorithm);

const FIXED_ALGORITHMS: Readonly<Record<string, Algorithm>> = {
  md5sum: 'md5', sha1sum: 'sha1', sha224sum: 'sha224', sha256sum: 'sha256', sha384sum: 'sha384', sha512sum: 'sha512', b2sum: 'blake2b',
};

export const CHECKSUM_PROGRAMS: readonly string[] = ['cksum', ...Object.keys(FIXED_ALGORITHMS)];

function escapeName(name: string, zero: boolean): { prefix: string; text: string } {
  if (zero || !/[\\\n]/.test(name)) return { prefix: '', text: name };
  return { prefix: '\\', text: name.replace(/\\/g, '\\\\').replace(/\n/g, '\\n') };
}

function unescapeName(text: string): string {
  return text.replace(/\\(\\|n)/g, (_, kind: string) => (kind === 'n' ? '\n' : '\\'));
}

export function runCksum(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  return runChecksum('cksum', args, io);
}

export function runChecksum(program: string, args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const fixed = FIXED_ALGORITHMS[program] ?? null;
  let algorithm: Algorithm = fixed ?? 'crc';
  let algorithmGiven = fixed !== null;
  let check = false;
  let tag = false;
  let untagged = fixed !== null;
  let raw = false;
  let warn = false;
  let binary = false;
  let status = false;
  let quiet = false;
  let ignoreMissing = false;
  let strict = false;
  let lengthText: string | null = null;
  let terminator = '\n';
  const operands: string[] = [];
  const streams = new Streams();
  const allowed = fixed === null ? LONG_OPTIONS : LONG_OPTIONS.filter((option) => !['algorithm', 'debug', 'raw', 'untagged'].includes(option.name)
    && (option.name !== 'length' || fixed === 'blake2b'));
  const optstring = fixed === null ? 'a:bcl:twz' : fixed === 'blake2b' ? 'bcl:twz' : 'bctwz';
  for (const item of shortOptions(args, optstring, allowed)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure(program, getoptDiagnostic(program, item));
    switch (item.letter) {
      case 'H': return docsResult(program, 'help');
      case 'V': return docsResult(program, 'version');
      case 'a': {
        const matched = matchArgument(item.argument ?? '', ALGORITHMS);
        if (matched === 'invalid' || matched === 'ambiguous') {
          return usageFailure(program, argumentFailure(program, matched, item.argument ?? '', '--algorithm', ALGORITHMS.map(([name]) => name)));
        }
        algorithm = matched;
        algorithmGiven = true;
        break;
      }
      case 'b': binary = true; break;
      case 't': binary = false; break;
      case 'c': check = true; break;
      case 'l': lengthText = item.argument ?? ''; break;
      case 'G': tag = true; untagged = false; break;
      case 'U': untagged = true; tag = false; break;
      case 'R': raw = true; break;
      case 'S': status = true; break;
      case 'w': warn = true; break;
      case 'q': quiet = true; break;
      case 'I': ignoreMissing = true; break;
      case 'T': strict = true; break;
      case 'z': terminator = '\0'; break;
      default: break;
    }
  }
  let bits = 512;
  if (lengthText !== null) {
    if (algorithm !== 'blake2b') {
      streams.diagnostic(`${program}: --length is only supported with --algorithm=blake2b`);
      streams.exitCode = 1;
      return streams.result();
    }
    if (!/^\d+$/.test(lengthText)) {
      streams.diagnostic(`${program}: invalid length: ${quoteLocale(lengthText)}`);
      streams.exitCode = 1;
      return streams.result();
    }
    if (Number(lengthText) > 512) {
      streams.diagnostic(`${program}: invalid length: ${quoteLocale(lengthText)}`);
      streams.diagnostic(`${program}: maximum digest length for ${quoteLocale('BLAKE2b')} is 512 bits`);
      streams.exitCode = 1;
      return streams.result();
    }
    bits = Number(lengthText) === 0 ? 512 : Number(lengthText);
    if (bits % 8 !== 0) {
      streams.diagnostic(`${program}: invalid length: ${quoteLocale(lengthText)}`);
      streams.diagnostic(`${program}: length is not a multiple of 8`);
      streams.exitCode = 1;
      return streams.result();
    }
  }
  if (check && tag) return usageFailure(program, `${program}: the --tag option is meaningless when verifying checksums`);
  if (!check) {
    const meaningless = ([['warn', warn], ['quiet', quiet], ['status', status], ['strict', strict], ['ignore-missing', ignoreMissing]] as const).find(([, given]) => given);
    if (meaningless !== undefined) return usageFailure(program, `${program}: the --${meaningless[0]} option is meaningful only when verifying checksums`);
  }
  const queue = new InputQueue(io);
  const readBytes = (name: string): Uint8Array | string => {
    const read = queue.read(name);
    return read.kind === 'ok' ? toBytes(read.text) : readFailureText(read);
  };

  if (check) {
    let mismatches = 0;
    let unreadable = 0;
    let improper = 0;
    for (const listName of operands.length === 0 ? ['-'] : operands) {
      const listing = queue.read(listName);
      if (listing.kind !== 'ok') {
        streams.diagnostic(`${program}: ${quotef(listName)}: ${readFailureText(listing)}`);
        streams.exitCode = 1;
        continue;
      }
      let proper = 0;
      let verified = 0;
      const improperLines: number[] = [];
      let lineNumber = 0;
      for (const line of listing.text.split(terminator)) {
        lineNumber++;
        if (line === '') continue;
        const escaped = line.startsWith('\\');
        const body = escaped ? line.slice(1) : line;
        const tagged = /^(\S+?)(?:-(\d+))? \((.*)\) = ([0-9a-fA-F]+)$/.exec(body);
        const plain = /^([0-9a-fA-F]+) [ *](.*)$/.exec(body);
        let algo: Algorithm | null = null;
        let name = '';
        let expected = '';
        let lineBits = 512;
        if (tagged !== null) {
          const found = ALGORITHMS.find(([, value]) => TAGS[value] === tagged[1]);
          if (found !== undefined && isDigest(found[1]) && (fixed === null || found[1] === fixed)) {
            algo = found[1]; name = tagged[3]; expected = tagged[4].toLowerCase();
            lineBits = tagged[2] === undefined ? 512 : Number(tagged[2]);
          }
        } else if (plain !== null && algorithmGiven && isDigest(algorithm)) {
          const hexLength = plain[1].length;
          const fits = algorithm === 'blake2b' ? hexLength % 2 === 0 && hexLength >= 2 && hexLength <= 128 : hexLength === digestHex(algorithm, new Uint8Array(0), 512).length;
          if (fits) {
            algo = algorithm; name = plain[2]; expected = plain[1].toLowerCase();
            lineBits = algorithm === 'blake2b' ? hexLength * 4 : bits;
          }
        }
        if (algo === null) { improperLines.push(lineNumber); continue; }
        if (escaped) name = unescapeName(name);
        proper++;
        const read = name === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(name);
        if (read.kind !== 'ok') {
          if (ignoreMissing && read.kind === 'missing') continue;
          unreadable++;
          streams.diagnostic(`${program}: ${quotef(name)}: ${readFailureText(read)}`);
          if (!status) streams.stdout(`${name}: FAILED open or read\n`);
          continue;
        }
        verified++;
        const actual = digestHex(algo, toBytes(read.text), lineBits);
        if (actual === expected) { if (!status && !quiet) streams.stdout(`${name}: OK\n`); } else { mismatches++; if (!status) streams.stdout(`${name}: FAILED\n`); }
      }
      if (warn) for (const number of improperLines) streams.diagnostic(`${program}: ${quotef(listName)}: ${number}: improperly formatted ${TAGS[algorithm]} checksum line`);
      if (proper > 0) improper += improperLines.length;
      if (proper === 0) {
        streams.diagnostic(`${program}: ${quotef(listName === '-' ? 'standard input' : listName)}: no properly formatted checksum lines found`);
        streams.exitCode = 1;
      } else if (ignoreMissing && verified === 0) {
        streams.diagnostic(`${program}: ${quotef(listName === '-' ? 'standard input' : listName)}: no file was verified`);
        streams.exitCode = 1;
      }
    }
    if (!status) {
      if (improper > 0) streams.diagnostic(`${program}: WARNING: ${improper} ${improper === 1 ? 'line is' : 'lines are'} improperly formatted`);
      if (unreadable > 0) streams.diagnostic(`${program}: WARNING: ${unreadable} listed ${unreadable === 1 ? 'file' : 'files'} could not be read`);
      if (mismatches > 0) streams.diagnostic(`${program}: WARNING: ${mismatches} computed ${mismatches === 1 ? 'checksum' : 'checksums'} did NOT match`);
    }
    if (mismatches > 0 || unreadable > 0 || (strict && improper > 0)) streams.exitCode = 1;
    return streams.result();
  }

  for (const name of operands.length === 0 ? ['-'] : operands) {
    const data = readBytes(name);
    if (typeof data === 'string') {
      streams.diagnostic(`${program}: ${quotef(name)}: ${data}`);
      streams.exitCode = 1;
      continue;
    }
    const shown = name === '-' && !isDigest(algorithm) ? '' : name;
    if (raw) {
      const value = algorithm === 'crc' ? posixCrc(data) : algorithm === 'bsd' ? bsdSum(data) : sysvSum(data);
      const width = algorithm === 'crc' ? 4 : 2;
      const bytes = Uint8Array.from({ length: width }, (_, index) => (value >>> (8 * (width - 1 - index))) & 0xff);
      streams.stdout(fromBytes(bytes));
      continue;
    }
    if (algorithm === 'crc') { streams.stdout(`${posixCrc(data)} ${data.length}${shown === '' ? '' : ` ${shown}`}${terminator}`); continue; }
    if (algorithm === 'bsd') { streams.stdout(`${String(bsdSum(data)).padStart(5, '0')} ${String(Math.ceil(data.length / 1024)).padStart(5)}${shown === '' ? '' : ` ${shown}`}${terminator}`); continue; }
    if (algorithm === 'sysv') { streams.stdout(`${sysvSum(data)} ${Math.ceil(data.length / 512)}${shown === '' ? '' : ` ${shown}`}${terminator}`); continue; }
    const hex = digestHex(algorithm, data, bits);
    const label = algorithm === 'blake2b' && bits !== 512 ? `${TAGS[algorithm]}-${bits}` : TAGS[algorithm];
    const escaped = escapeName(name, terminator === '\0');
    streams.stdout(untagged
      ? `${escaped.prefix}${hex} ${binary ? '*' : ' '}${escaped.text}${terminator}`
      : `${escaped.prefix}${label} (${escaped.text}) = ${hex}${terminator}`);
  }
  return streams.result();
}

const SUM_OPTIONS: readonly LongOption[] = [
  { name: 'sysv', letter: 's', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function runSum(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let sysv = false;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'rs', SUM_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('sum', getoptDiagnostic('sum', item));
    if (item.letter === 'H') return docsResult('sum', 'help');
    if (item.letter === 'V') return docsResult('sum', 'version');
    sysv = item.letter === 's';
  }
  const streams = new Streams();
  const queue = new InputQueue(io);
  const named = operands.length > 0;
  for (const name of named ? operands : ['-']) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`sum: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    const data = toBytes(read.text);
    const label = named ? ` ${name}` : '';
    streams.stdout(sysv
      ? `${sysvSum(data)} ${Math.ceil(data.length / 512)}${label}\n`
      : `${String(bsdSum(data)).padStart(5, '0')} ${String(Math.ceil(data.length / 1024)).padStart(5)}${label}\n`);
  }
  return streams.result();
}
