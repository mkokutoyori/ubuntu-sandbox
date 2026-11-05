import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, quoteLocale, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'exponents', letter: 'h', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const SMALL_PRIMES: readonly bigint[] = (() => {
  const primes: bigint[] = [];
  for (let candidate = 2; primes.length < 168; candidate++) {
    if (primes.every((prime) => candidate % Number(prime) !== 0)) primes.push(BigInt(candidate));
  }
  return primes;
})();

const MILLER_RABIN_BASES: readonly bigint[] = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n];

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

function isProbablePrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (const prime of SMALL_PRIMES) {
    if (n === prime) return true;
    if (n % prime === 0n) return false;
  }
  let d = n - 1n;
  let twos = 0;
  while ((d & 1n) === 0n) { d >>= 1n; twos++; }
  for (const base of MILLER_RABIN_BASES) {
    let x = modPow(base, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let round = 1; round < twos; round++) {
      x = (x * x) % n;
      if (x === n - 1n) { composite = false; break; }
    }
    if (composite) return false;
  }
  return true;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) { [x, y] = [y, x % y]; }
  return x;
};

function pollardRho(n: bigint): bigint {
  if ((n & 1n) === 0n) return 2n;
  for (let seed = 1n; ; seed++) {
    const step = (x: bigint): bigint => (x * x + seed) % n;
    let tortoise = 2n;
    let hare = 2n;
    let divisor = 1n;
    while (divisor === 1n) {
      tortoise = step(tortoise);
      hare = step(step(hare));
      divisor = gcd(tortoise > hare ? tortoise - hare : hare - tortoise, n);
    }
    if (divisor !== n) return divisor;
  }
}

function factorize(value: bigint): bigint[] {
  const factors: bigint[] = [];
  let rest = value;
  for (const prime of SMALL_PRIMES) {
    while (rest % prime === 0n) { factors.push(prime); rest /= prime; }
    if (prime * prime > rest) break;
  }
  const pending: bigint[] = rest > 1n ? [rest] : [];
  while (pending.length > 0) {
    const current = pending.pop() as bigint;
    if (current === 1n) continue;
    if (isProbablePrime(current)) { factors.push(current); continue; }
    const divisor = pollardRho(current);
    pending.push(divisor, current / divisor);
  }
  return factors.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function render(token: string, exponents: boolean): string | null {
  if (!/^\+?\d+$/.test(token)) return null;
  const value = BigInt(token.replace(/^\+/, ''));
  const factors = value < 2n ? [] : factorize(value);
  if (!exponents) return `${value}:${factors.map((factor) => ` ${factor}`).join('')}`;
  const groups: string[] = [];
  for (let at = 0; at < factors.length;) {
    let end = at;
    while (end < factors.length && factors[end] === factors[at]) end++;
    groups.push(end - at === 1 ? `${factors[at]}` : `${factors[at]}^${end - at}`);
    at = end;
  }
  return `${value}:${groups.map((group) => ` ${group}`).join('')}`;
}

export function runFactor(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let exponents = false;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'h', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('factor', getoptDiagnostic('factor', item));
    if (item.letter === 'H') return docsResult('factor', 'help');
    if (item.letter === 'V') return docsResult('factor', 'version');
    exponents = true;
  }
  const streams = new Streams();
  const queue = new InputQueue(io);
  const tokens = operands.length > 0 ? operands : queue.read('-').kind === 'ok' ? (io.stdin ?? '').split(/\s+/).filter((token) => token !== '') : [];
  let output = '';
  for (const token of tokens) {
    const line = render(token, exponents);
    if (line === null) {
      streams.diagnostic(`factor: ${quoteLocale(token)} is not a valid positive integer`);
      streams.exitCode = 1;
      continue;
    }
    output += `${line}\n`;
  }
  streams.stdout(output);
  return streams.result();
}
