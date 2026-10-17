import { simulationNowMs } from '@/network/core/SystemClock';
import { systemRandom } from '@/crypto/random';
import {
  DEFAULT_TRIALS,
  LARGE_MAXIMUM_MEGABYTES,
  LARGE_MINIMUM_MEGABYTES,
  MODULI_TESTS_SIEVE,
  MODULI_TYPE_SAFE,
  MODULI_TYPE_SOPHIE_GERMAIN,
  TEST_MAXIMUM,
  TEST_MINIMUM,
  TRIAL_MINIMUM,
  ctimeText,
  moduliLine,
  parseCandidateLine,
  planWindow,
  screenCandidate,
  sieveCandidates,
  startingPoint,
} from './ModuliEngine';
import { strtonum } from './KeygenRequest';
import { printError, type KeygenDialogue, type KeygenRequest, type SshKeygenHost } from './KeygenTypes';

const DEFAULT_MODULI_BITS = 3072;
const INT_MAX = 0x7fffffff;
const UINT_MAX = 0xffffffff;
const NO_SUCH_FILE = 'No such file or directory';

function* fatal(message: string): KeygenDialogue {
  yield printError(message);
  return 255;
}

function nowMs(host: SshKeygenHost): number {
  return host.nowSeconds === undefined ? simulationNowMs() : host.nowSeconds() * 1000;
}

function stamp(host: SshKeygenHost): string {
  const at = nowMs(host);
  return ctimeText(at, host.zoneOffsetMinutes?.(at) ?? 0);
}

export function* moduliDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  if (request.operands.length === 0) return yield* fatal('No output file specified');
  if (request.operands.length > 1) return yield* fatal('Too many output files specified');
  const output = request.operands[0];
  return request.moduliOperation === 'generate'
    ? yield* generateDialogue(request, host, output)
    : yield* screenDialogue(request, host, output);
}

function* generateDialogue(request: KeygenRequest, host: SshKeygenHost, output: string): KeygenDialogue {
  let memory = 0;
  let start: bigint | undefined;
  let bits = 0;
  for (const option of request.signerOptions) {
    if (option.startsWith('memory=')) {
      const parsed = strtonum(option.slice('memory='.length), UINT_MAX);
      if ('error' in parsed) return yield* fatal(`Memory limit is ${parsed.error}: ${option.slice('memory='.length)}`);
      memory = parsed.value;
    } else if (option.startsWith('start=')) {
      const text = option.slice('start='.length);
      if (!/^[0-9a-fA-F]+$/.test(text)) return yield* fatal('Invalid start point.');
      start = BigInt(`0x${text}`);
    } else if (option.startsWith('bits=')) {
      const parsed = strtonum(option.slice('bits='.length), INT_MAX);
      if ('error' in parsed) return yield* fatal(`Invalid number: ${option.slice(12)} (${parsed.error})`);
      bits = parsed.value;
    } else {
      return yield* fatal(`Option "${option}" is unsupported for moduli generation`);
    }
  }
  const failure = host.store.write(output, '', false);
  if (failure !== null) return yield* fatal(`Couldn't open modulus candidate file "${output}": ${failure}`);
  if (bits === 0) bits = DEFAULT_MODULI_BITS;

  if (memory !== 0 && (memory < LARGE_MINIMUM_MEGABYTES || memory > LARGE_MAXIMUM_MEGABYTES)) {
    yield printError(`Invalid memory amount (min ${LARGE_MINIMUM_MEGABYTES}, max ${LARGE_MAXIMUM_MEGABYTES})`);
    return yield* fatal('modulus candidate generation failed');
  }
  if (bits > TEST_MAXIMUM) {
    yield printError(`Too many bits: ${bits} > ${TEST_MAXIMUM}`);
    return yield* fatal('modulus candidate generation failed');
  }
  if (bits < TEST_MINIMUM) {
    yield printError(`Too few bits: ${bits} < ${TEST_MINIMUM}`);
    return yield* fatal('modulus candidate generation failed');
  }
  const power = bits - 1;
  const plan = planWindow(power, memory);
  for (const notice of plan.notices) yield printError(notice);
  const base = (start ?? startingPoint(power, systemRandom)) | 1n;
  const began = nowMs(host);
  const outcome = sieveCandidates(base, plan.largewords);
  yield printError(`${ctimeText(began, host.zoneOffsetMinutes?.(began) ?? 0)} Sieve next ${outcome.numbers} plus ${power}-bit`);
  const seconds = Math.floor(nowMs(host) / 1000);
  const lines = outcome.survivors.map((q) => moduliLine(seconds, MODULI_TYPE_SOPHIE_GERMAIN, MODULI_TESTS_SIEVE, outcome.tries, power - 1, 0, q));
  const written = host.store.write(output, lines.length === 0 ? '' : `${lines.join('\n')}\n`, false);
  if (written !== null) return yield* fatal('modulus candidate generation failed');
  yield printError(`${stamp(host)} Sieved with ${outcome.tries} small primes in ${Math.max(0, Math.floor(nowMs(host) / 1000) - Math.floor(began / 1000))} seconds`);
  yield printError(`${stamp(host)} Found ${outcome.survivors.length} candidates`);
  return 0;
}

function* screenDialogue(request: KeygenRequest, host: SshKeygenHost, output: string): KeygenDialogue {
  let checkpoint: string | undefined;
  let wantedGenerator = 0;
  let startLine = 0;
  let linesToProcess = 0;
  let trials = 0;
  for (const option of request.signerOptions) {
    if (option.startsWith('lines=')) {
      linesToProcess = Number.parseInt(option.slice('lines='.length), 10) || 0;
    } else if (option.startsWith('start-line=')) {
      startLine = Number.parseInt(option.slice('start-line='.length), 10) || 0;
    } else if (option.startsWith('checkpoint=')) {
      checkpoint = option.slice('checkpoint='.length);
    } else if (option.startsWith('generator=')) {
      const parsed = strtonum(option.slice('generator='.length), UINT_MAX);
      if ('error' in parsed) return yield* fatal(`Generator invalid: ${option.slice('generator='.length)} (${parsed.error})`);
      wantedGenerator = parsed.value;
    } else if (option.startsWith('prime-tests=')) {
      const parsed = strtonum(option.slice('prime-tests='.length), INT_MAX);
      if ('error' in parsed) return yield* fatal(`Invalid number: ${option.slice('prime-tests='.length)} (${parsed.error})`);
      trials = parsed.value;
    } else {
      return yield* fatal(`Option "${option}" is unsupported for moduli screening`);
    }
  }
  const fromStdin = request.file === undefined || request.file === '-';
  const input = fromStdin ? (host.stdin ?? '') : host.store.read(request.file ?? '');
  if (input === null) return yield* fatal(`Couldn't open modulus candidate file "${request.file}": ${NO_SUCH_FILE}`);
  const existing = host.store.read(output) ?? '';
  const opened = host.store.write(output, existing, false);
  if (opened !== null) return yield* fatal(`Couldn't open moduli file "${output}": ${opened}`);
  const effectiveTrials = trials === 0 ? DEFAULT_TRIALS : trials;
  if (effectiveTrials < TRIAL_MINIMUM) {
    yield printError(`Minimum primality trials is ${TRIAL_MINIMUM}`);
    return yield* fatal('modulus screening failed');
  }

  const rows = input.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const endLine = linesToProcess === 0 ? (fromStdin ? Number.MAX_SAFE_INTEGER : rows.length) : startLine + linesToProcess;
  const began = nowMs(host);
  let lastProcessed = 0;
  if (checkpoint !== undefined) lastProcessed = Number.parseInt((host.store.read(checkpoint) ?? '').trim(), 10) || 0;
  lastProcessed = Math.max(lastProcessed, startLine);
  const accepted: string[] = [];
  let possible = 0;
  let consumed = 0;
  for (const row of rows) {
    if (consumed >= endLine) break;
    consumed += 1;
    if (consumed <= lastProcessed) continue;
    if (checkpoint !== undefined) host.store.write(checkpoint, `${consumed}\n`, false);
    if (row.length < 14 || row.startsWith('!') || row.startsWith('#')) continue;
    const candidate = parseCandidateLine(row);
    if (candidate === null) continue;
    const result = screenCandidate(candidate, effectiveTrials, wantedGenerator);
    if (result.counted) possible += 1;
    if (result.prime === null) continue;
    const seconds = Math.floor(nowMs(host) / 1000);
    accepted.push(moduliLine(seconds, MODULI_TYPE_SAFE, result.prime.tests, result.prime.tries, result.prime.size, result.prime.generator, result.prime.modulus));
  }
  if (accepted.length > 0) {
    const failure = host.store.write(output, `${existing}${accepted.join('\n')}\n`, false);
    if (failure !== null) return yield* fatal('modulus screening failed');
  }
  if (checkpoint !== undefined) host.store.remove?.(checkpoint);
  yield printError(`${stamp(host)} Found ${accepted.length} safe primes of ${possible} candidates in ${Math.max(0, Math.floor(nowMs(host) / 1000) - Math.floor(began / 1000))} seconds`);
  return 0;
}
