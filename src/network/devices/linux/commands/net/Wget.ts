import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { listenForInterruption } from '../CommandInterruption';
import type { CurlHost } from '@/network/http/curl/CurlHost';
import { runCurl } from '@/network/http/curl/CurlEngine';
import { IPAddress } from '@/network/core/types';
import { simulationDate } from '@/network/core/SystemClock';
import { PathClock } from '@/network/core/time/PathClock';
import { commandCurlHost } from './Curl';

const USAGE_TAIL = "Usage: wget [OPTION]... [URL]...\n\nTry `wget --help' for more options.";
const VERSION = 'GNU Wget 1.21.2 built on linux-gnu.';
const BODY_SLOT = '\0wget-body';
const HEADER_SLOT = '\0wget-headers';

interface Options {
  quiet: boolean;
  noVerbose: boolean;
  spider: boolean;
  serverResponse: boolean;
  output: string | null;
  timeout: number;
  directoryPrefix: string | null;
  version: boolean;
  urls: string[];
}

interface Refusal { readonly ok: false; readonly output: string; readonly exitCode: number }

type Parsed = { readonly ok: true; readonly options: Options } | Refusal;

const refuse = (message: string, exitCode: number): Refusal => ({ ok: false, output: `${message}\n${USAGE_TAIL}`, exitCode });

function parseArguments(args: readonly string[]): Parsed {
  const options: Options = {
    quiet: false, noVerbose: false, spider: false, serverResponse: false, output: null, timeout: 900, directoryPrefix: null, version: false, urls: [],
  };
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const valued = (flag: string): string | null => {
      if (word === flag) return args[++i] ?? null;
      return null;
    };
    if (word === '-q' || word === '--quiet') options.quiet = true;
    else if (word === '-nv' || word === '--no-verbose') options.noVerbose = true;
    else if (word === '--spider') options.spider = true;
    else if (word === '-S' || word === '--server-response') options.serverResponse = true;
    else if (word === '-V' || word === '--version') options.version = true;
    else if (word === '-O' || word === '--output-document') {
      const value = valued(word);
      if (value === null) return refuse(`wget: option requires an argument -- 'O'`, 2);
      options.output = value;
    } else if (word.startsWith('--output-document=')) options.output = word.slice(18);
    else if (word.startsWith('-O') && word.length > 2) options.output = word.slice(2);
    else if (word === '-T' || word === '--timeout') {
      const value = valued(word);
      if (value === null) return refuse(`wget: option requires an argument -- 'T'`, 2);
      options.timeout = Number(value);
    } else if (word.startsWith('--timeout=')) options.timeout = Number(word.slice(10));
    else if (word === '-t' || word === '--tries') i++;
    else if (word.startsWith('--tries=')) continue;
    else if (word === '-P' || word === '--directory-prefix') {
      const value = valued(word);
      if (value === null) return refuse(`wget: option requires an argument -- 'P'`, 2);
      options.directoryPrefix = value;
    } else if (word.startsWith('--directory-prefix=')) options.directoryPrefix = word.slice(19);
    else if (word.startsWith('--')) return refuse(`wget: unrecognized option '${word}'`, 2);
    else if (word.startsWith('-') && word.length > 1) {
      const letters = word.slice(1);
      for (let at = 0; at < letters.length; at++) {
        const letter = letters[at];
        if (letter === 'q') options.quiet = true;
        else if (letter === 'S') options.serverResponse = true;
        else if (letter === 'V') options.version = true;
        else if ('OTtP'.includes(letter)) {
          const attached = letters.slice(at + 1);
          const value = attached !== '' ? attached : (args[++i] ?? null);
          if (value === null) return refuse(`wget: option requires an argument -- '${letter}'`, 2);
          if (letter === 'O') options.output = value;
          else if (letter === 'T') options.timeout = Number(value);
          else if (letter === 'P') options.directoryPrefix = value;
          break;
        } else return refuse(`wget: invalid option -- '${letter}'`, 2);
      }
    } else options.urls.push(word);
  }
  return { ok: true, options };
}

function humanLength(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  const units = ['K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${bytes} (${value.toFixed(1).replace(/\.0$/, '.0')}${units[unit]})`;
}

function rateText(bytes: number, seconds: number): { progress: string; summary: string } {
  const perSecond = bytes / Math.max(seconds, 1e-6);
  const progressUnits = ['K', 'M', 'G', 'T'];
  let scaled = perSecond / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < progressUnits.length - 1) { scaled /= 1024; unit++; }
  const summaryUnits = ['KB/s', 'MB/s', 'GB/s', 'TB/s'];
  return {
    progress: `${scaled.toFixed(scaled >= 100 ? 0 : 2)}${progressUnits[unit]}`,
    summary: `${scaled.toFixed(2)} ${summaryUnits[unit]}`,
  };
}

function stamp(): string {
  return simulationDate().toISOString().replace('T', ' ').slice(0, 19);
}

function progressLine(bytes: number, rate: string): string {
  const dots = '.'.repeat(Math.min(50, Math.floor(bytes / 1024)));
  const grouped = (dots.match(/.{1,10}/g) ?? []).join(' ');
  return `${'0'.padStart(6)}K ${grouped.padEnd(54)} 100% ${rate}=0s`;
}

function lastHeaderBlock(dump: string): { status: number; reason: string; headers: Map<string, string>; raw: string[] } {
  const blocks = dump.split(/\r?\n\r?\n/).filter((block) => block.trim() !== '');
  const block = blocks[blocks.length - 1] ?? '';
  const lines = block.split(/\r?\n/);
  const status = /^HTTP\/\S+\s+(\d{3})\s*(.*)$/.exec(lines[0] ?? '');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: status ? Number(status[1]) : 0, reason: status ? status[2] : '', headers, raw: lines };
}

interface Target { readonly scheme: string; readonly host: string; readonly port: number; readonly path: string; readonly text: string }

function parseUrl(raw: string): Target | null {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const match = /^(https?):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?([^#]*)/i.exec(text);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  return { scheme, host: match[2].replace(/^\[|\]$/g, ''), port: match[3] ? Number(match[3]) : scheme === 'https' ? 443 : 80, path: match[4] || '/', text };
}

function fileNameFor(target: Target): string {
  const last = target.path.split('?')[0].split('/').filter((part) => part !== '').pop();
  return last === undefined || target.path.endsWith('/') ? 'index.html' : last;
}

async function runWget(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number; stderr: string }> {
  const parsed = parseArguments(args);
  if (!('options' in parsed)) return { output: '', exitCode: parsed.exitCode, stderr: parsed.output };
  const { options } = parsed;
  if (options.version) return { output: VERSION, exitCode: 0, stderr: '' };
  if (options.urls.length === 0) return { output: '', exitCode: 1, stderr: `wget: missing URL\n${USAGE_TAIL}` };

  const interruption = listenForInterruption(ctx);
  const messages: string[] = [];
  const say = (line: string): void => { if (!options.quiet) messages.push(line); };
  let body = '';
  let exitCode = 0;
  try {
    const captured = new Map<string, string>();
    const base = commandCurlHost(ctx, interruption.signal);
    const host: CurlHost = { ...base, writeFile: (target, content) => { captured.set(target, content); return true; } };
    const vfs = ctx.executor.vfs;
    for (const raw of options.urls) {
      const target = parseUrl(raw);
      if (target === null) {
        say(`${raw}: Unsupported scheme '${raw.split(':')[0]}'.`);
        exitCode = 1;
        continue;
      }
      if (options.spider) say('Spider mode enabled. Check if remote file exists.');
      say(`--${stamp()}--  ${target.text}`);
      const literal = IPAddress.tryParse(target.host) !== null || target.host.includes(':');
      let address = literal ? target.host : null;
      if (!literal) {
        address = await host.resolveHostname(target.host);
        if (address === null) {
          say(`Resolving ${target.host} (${target.host})... failed: Name or service not known.`);
          say(`wget: unable to resolve host address '${target.host}'`);
          exitCode = 4;
          continue;
        }
        say(`Resolving ${target.host} (${target.host})... ${address}`);
      }
      const portText = target.port === (target.scheme === 'https' ? 443 : 80) && literal ? `${address}:${target.port}` : `${target.host} (${target.host})|${address}|:${target.port}`;
      const connecting = literal ? `Connecting to ${address}:${target.port}...` : `Connecting to ${portText}...`;
      captured.delete(BODY_SLOT);
      captured.delete(HEADER_SLOT);
      const started = PathClock.now();
      const run = await runCurl(host, [
        '-sS', '-L', '--max-redirs', '20', '-m', String(options.timeout), ...(options.spider ? ['-I'] : ['-o', BODY_SLOT]),
        '-D', HEADER_SLOT, target.text,
      ]);
      if (run.exitCode === 6) {
        say(`${connecting} failed: Name or service not known.`);
        exitCode = 4;
        continue;
      }
      if (run.exitCode === 7 || run.exitCode === 28 || (run.exitCode !== 0 && !captured.has(HEADER_SLOT))) {
        const reason = run.exitCode === 28 ? 'Connection timed out' : run.exitCode === 7 ? 'Connection refused' : (run.stderr.replace(/^curl: \(\d+\) /, '') || 'Connection failed');
        say(`${connecting} failed: ${reason}.`);
        exitCode = 4;
        continue;
      }
      const response = lastHeaderBlock(captured.get(HEADER_SLOT) ?? '');
      say(`${connecting} connected.`);
      if (options.serverResponse) {
        say('HTTP request sent, awaiting response... ');
        for (const line of response.raw) if (line.trim() !== '') say(`  ${line.trim()}`);
        say(` ${response.status} ${response.reason}`.trimEnd());
      } else {
        say(`HTTP request sent, awaiting response... ${response.status} ${response.reason}`.trimEnd());
      }
      if (response.status >= 400 || response.status === 0) {
        say(`${stamp()} ERROR ${response.status}: ${response.reason}.`);
        say('');
        exitCode = 8;
        continue;
      }
      const length = response.headers.get('content-length');
      const type = response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
      const payload = captured.get(BODY_SLOT) ?? '';
      say(`Length: ${length === undefined ? 'unspecified' : humanLength(Number(length))} [${type}]`);
      if (options.spider) {
        say('Remote file exists and could contain further links,');
        say('but recursion is disabled -- not retrieving.');
        say('');
        continue;
      }
      const size = length === undefined ? payload.length : Number(length);
      if (options.output === '-') {
        say("Saving to: 'STDOUT'");
        say('');
        body += payload;
      } else {
        const directory = options.directoryPrefix === null ? '' : `${options.directoryPrefix.replace(/\/$/, '')}/`;
        let name = options.output ?? fileNameFor(target);
        let path = `${directory}${name}`;
        if (options.output === null) {
          for (let n = 1; vfs.exists(vfs.normalizePath(path, ctx.executor.getCwd())); n++) path = `${directory}${name}.${n}`;
          name = path.slice(directory.length);
        }
        say(`Saving to: '${path}'`);
        say('');
        ctx.executor.vfs.writeFile(vfs.normalizePath(path, ctx.executor.getCwd()), payload, ctx.executor.userMgr.currentUid, ctx.executor.userMgr.currentGid, 0o022);
        const rate = rateText(size, (PathClock.now() - started) / 1000);
        if (options.noVerbose) {
          messages.push(`${stamp()} URL:${target.text} [${size}/${size}] -> "${path}" [1]`);
          continue;
        }
        say(progressLine(size, rate.progress));
        say('');
        say(`${stamp()} (${rate.summary}) - '${path}' saved [${size}/${size}]`);
        say('');
        continue;
      }
      const rate = rateText(size, (PathClock.now() - started) / 1000);
      say(progressLine(size, rate.progress));
      say('');
      say(`${stamp()} (${rate.summary}) - 'STDOUT' saved [${size}/${size}]`);
      say('');
    }
    const status = interruption.exitStatus();
    if (status !== null) return { output: '', exitCode: status, stderr: '' };
    const noVerboseOnly = options.noVerbose && !options.quiet;
    const stderr = noVerboseOnly ? messages.filter((line) => /URL:|ERROR/.test(line)).join('\n') : messages.join('\n');
    return { output: body, exitCode, stderr };
  } finally {
    interruption.release();
  }
}

export const wgetCommand: LinuxCommand = {
  name: 'wget',
  package: 'wget',
  needsNetworkContext: true,
  foregroundClient: true,
  manSection: 1,
  usage: 'wget [OPTION]... [URL]...',
  help: 'The non-interactive network downloader.',
  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const result = await runWget(ctx, args);
    return [result.output, result.stderr].filter((text) => text.length > 0).join('\n');
  },
  runWithStatus: runWget,
};
