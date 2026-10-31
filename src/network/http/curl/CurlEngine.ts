import { simulationNowMs } from '@/network/core/SystemClock';

import { parseCurlArgs, remoteNameFor, CURL_USER_AGENT, type CurlOptions } from './CurlArgs';
import { parseCurlUrl, performCurlRequest, isRedirect, resolveLocation, type CurlOutcome, type CurlSuccess } from './CurlTransfer';
import { applyWriteOut, type WriteOutFacts, type WriteOutResult } from './CurlWriteOut';
import type { CurlHost } from './CurlHost';

export interface CurlRun {
  readonly output: string;
  readonly exitCode: number;
  readonly stderr: string;
}

export const CURL_FLAGS: readonly string[] = [
  '-I', '--head', '-i', '--include', '-k', '--insecure', '-s', '--silent',
  '-S', '--show-error', '-v', '--verbose', '-f', '--fail', '-L', '--location',
  '-O', '--remote-name', '-o', '--output', '-w', '--write-out', '-X', '--request',
  '-d', '--data', '--data-raw', '-H', '--header', '-u', '--user', '-A',
  '--user-agent', '--resolve', '--max-redirs',
];

export const CURL_USAGE =
  'curl [-fiIkLOsSv] [-o file] [-w format] [-X method] [-d data] [-H header] [-u user:password] [--resolve host:port:addr] URL...';

/**
 * Ce que curl juge TRANSITOIRE, c'est-à-dire ce qui vaut la peine
 * d'être retenté.
 *
 * La liste est la sienne, et elle est courte à dessein : un `404` ou un
 * certificat invalide ne s'améliorent pas en insistant. `--retry-all-errors`
 * existe précisément pour passer outre, et n'a de sens que parce que le
 * défaut est restrictif.
 */
const STATUTS_TRANSITOIRES = new Set([408, 429, 500, 502, 503, 504]);

/** Connexion refusée, coupée, ou pas de réponse du tout. */
const CODES_TRANSITOIRES = new Set([7, 28, 52, 56]);

function retryWorthy(outcome: CurlOutcome, opts: CurlOptions): boolean {
  if (outcome.ok === false) {
    return opts.retryAllErrors || CODES_TRANSITOIRES.has(outcome.code);
  }
  if (STATUTS_TRANSITOIRES.has(outcome.statusCode)) return true;
  // Un statut ordinaire n'est un échec que si `-f` le déclare tel ;
  // sans `-f`, un `404` est une réponse et non une panne.
  return opts.retryAllErrors && opts.fail && outcome.statusCode >= 400;
}

function transientLabel(outcome: CurlOutcome): string {
  return outcome.ok === false
    ? 'Connection refused'
    : `HTTP error ${outcome.statusCode}`;
}

function headerBlock(outcome: CurlSuccess): string {
  const status = `HTTP/${outcome.httpVersion} ${outcome.statusCode} ${outcome.reasonPhrase}`.trimEnd();
  return [status, ...outcome.headers.map((h) => `${h.name}: ${h.value}`), ''].join('\n');
}

function contentTypeOf(outcome: CurlSuccess): string {
  return outcome.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
}

const MICROSECONDS_PER_MILLISECOND = 1000;
const CURL_LIBRARY_VERSION = 'libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0 zstd/1.5.5 libidn2/2.3.7 libpsl/0.21.2 (+libidn2/2.3.7) libssh/0.10.6/openssl/zlib nghttp2/1.59.0 librtmp/2.3 OpenLDAP/2.6.10';

function microsecondsSince(start: number, at: number | null): number {
  return at === null ? 0 : Math.max(0, at - start) * MICROSECONDS_PER_MILLISECOND;
}

function writeOutFacts(
  outcome: CurlOutcome,
  opts: CurlOptions,
  requestedUrl: string,
  urlNum: number,
  exitCode: number,
  errorMsg: string,
  elapsed: number,
  filename: string | null,
): WriteOutFacts {
  const stats = outcome.stats;
  const started = stats?.startedAt ?? 0;
  const totalMicroseconds = Math.round(elapsed * 1_000_000);
  const sizeDownload = outcome.ok === true ? outcome.body.length : 0;
  const location = outcome.ok === true && isRedirect(outcome.statusCode)
    ? outcome.headers.find((h) => h.name.toLowerCase() === 'location')?.value
    : undefined;
  const redirectTarget = location !== undefined && outcome.ok === true ? resolveLocation(outcome.url, location) : null;
  const url = outcome.url;
  return {
    httpCode: outcome.ok === true ? outcome.statusCode : 0,
    httpConnect: 0,
    urlEffective: url?.effective ?? requestedUrl,
    inputUrl: requestedUrl,
    urlNum,
    remoteIp: outcome.ok === true && outcome.remoteIp !== '' ? outcome.remoteIp : null,
    remotePort: outcome.ok === true ? outcome.url.port : 0,
    localIp: outcome.ok === true ? outcome.localIp : null,
    localPort: outcome.ok === true ? outcome.localPort : 0,
    sizeDownload,
    sizeUpload: stats?.uploadBytes ?? 0,
    sizeHeader: stats?.headerBytes ?? 0,
    sizeRequest: stats?.requestBytes ?? 0,
    contentType: outcome.ok === true ? (contentTypeOf(outcome) || null) : null,
    numRedirects: outcome.numRedirects,
    numConnects: stats?.connects ?? 0,
    numHeaders: outcome.ok === true ? outcome.headers.length : 0,
    method: outcome.method,
    scheme: outcome.ok === true ? outcome.url.scheme.toUpperCase() : null,
    httpVersion: outcome.ok === true ? outcome.httpVersion : '',
    exitCode,
    errorMsg: exitCode === 0 ? null : errorMsg,
    filenameEffective: filename,
    redirectUrl: redirectTarget !== null && redirectTarget.ok === true ? redirectTarget.url.effective : null,
    referer: opts.referer,
    sslVerifyResult: 0,
    proxySslVerifyResult: 0,
    ftpEntryPath: null,
    connId: urlNum,
    xferId: urlNum,
    timeNamelookup: microsecondsSince(started, stats?.namelookupAt ?? null),
    timeConnect: microsecondsSince(started, stats?.connectAt ?? null),
    timeAppconnect: microsecondsSince(started, stats?.appconnectAt ?? null),
    timePretransfer: microsecondsSince(started, stats?.pretransferAt ?? null),
    timeStarttransfer: microsecondsSince(started, stats?.starttransferAt ?? null),
    timeRedirect: (stats?.redirectMs ?? 0) * MICROSECONDS_PER_MILLISECOND,
    timeTotal: totalMicroseconds,
    speedDownload: totalMicroseconds > 0 ? Math.floor(sizeDownload / (totalMicroseconds / 1_000_000)) : 0,
    speedUpload: totalMicroseconds > 0 ? Math.floor((stats?.uploadBytes ?? 0) / (totalMicroseconds / 1_000_000)) : 0,
    headers: outcome.ok === true ? outcome.headers : [],
    curlVersion: CURL_LIBRARY_VERSION,
  };
}

function flushWriteOut(host: CurlHost, rendered: WriteOutResult, stdoutParts: string[], stderrLines: string[]): void {
  stdoutParts.push(rendered.stdout);
  if (rendered.stderr) stderrLines.push(rendered.stderr.replace(/\n$/, ''));
  for (const file of rendered.files) {
    const previous = file.append ? (host.readFile(file.path) ?? '') : '';
    host.writeFile(file.path, previous + file.content);
  }
}

function bareMessage(message: string): string {
  return message.replace(/^curl: \(\d+\) /, '');
}

async function runOneUrl(host: CurlHost, opts: CurlOptions, raw: string, urlNum: number): Promise<CurlRun> {
  const stderrLines: string[] = [];
  const stdoutParts: string[] = [];

  const pushError = (message: string): void => {
    if (!opts.silent || opts.showError) stderrLines.push(message);
  };

  const parsed = parseCurlUrl(raw);
  if (parsed.ok === false) {
    pushError(parsed.message);
    if (opts.writeOut) {
      const facts = writeOutFacts(
        {
          ok: false, code: parsed.code, message: parsed.message, url: null,
          remoteIp: '', method: 'GET', numRedirects: 0, trace: [],
        },
        opts, raw, urlNum, parsed.code, bareMessage(parsed.message), 0, opts.outputs[urlNum] ?? null,
      );
      flushWriteOut(host, applyWriteOut(opts.writeOut, facts), stdoutParts, stderrLines);
    }
    return { output: stdoutParts.join(''), exitCode: parsed.code, stderr: stderrLines.join('\n') };
  }

  const started = simulationNowMs();
  let outcome = await performCurlRequest(host, parsed.url, opts);
  // `--retry N` : N NOUVELLES tentatives après la première, et non N au
  // total — c'est le compte de curl, et se tromper d'un ferait échouer
  // un `--retry 1` que le vrai réussit.
  for (let essai = 0; essai < opts.retry && retryWorthy(outcome, opts); essai++) {
    stderrLines.push(`Warning: Transient problem: ${transientLabel(outcome)} `
      + `Will retry in 0 seconds. ${opts.retry - essai} retries left.`);
    outcome = await performCurlRequest(host, parsed.url, opts);
  }
  const elapsed = (simulationNowMs() - started) / 1000;

  if (opts.verbose) stderrLines.push(...outcome.trace);
  // `-D` écrit les en-têtes REÇUS dans un fichier, quelle que soit la
  // destination du corps : c'est ce qui la distingue de `-i`, laquelle
  // les mêle au corps.
  if (opts.dumpHeader && outcome.ok === true) {
    host.writeFile(opts.dumpHeader, `${headerBlock(outcome)}\n`);
  }

  let exitCode = 0;
  let errorMsg = '';

  if (outcome.ok === false) {
    exitCode = outcome.code;
    errorMsg = bareMessage(outcome.message);
    pushError(outcome.message);
  } else if (opts.fail && outcome.statusCode >= 400) {
    exitCode = 22;
    errorMsg = `The requested URL returned error: ${outcome.statusCode}`;
    pushError(`curl: (22) The requested URL returned error: ${outcome.statusCode}`);
  } else {
    let target = opts.outputs[urlNum] ?? null;
    if (!target && opts.remoteName) {
      const name = remoteNameFor(outcome.url.path);
      if (!name) {
        pushError('curl: Remote filename has no length!');
        exitCode = 23;
        errorMsg = 'Remote filename has no length!';
      } else {
        target = name;
      }
    }

    if (exitCode === 0) {
      const payload = (opts.head || opts.include ? headerBlock(outcome) + '\n' : '') +
        (opts.head ? '' : outcome.body);
      if (target && target !== '-') {
        if (host.writeFile(target, payload)) {
          stdoutParts.push('');
        } else {
          pushError(`curl: (23) Failure writing output to destination, passed ${payload.length} bytes`);
          exitCode = 23;
          errorMsg = 'Failure writing output to destination';
        }
      } else {
        stdoutParts.push(payload);
      }
    }
  }

  if (opts.writeOut) {
    const effectiveName = (opts.outputs[urlNum] ?? null) ?? (opts.remoteName && outcome.ok === true ? remoteNameFor(outcome.url.path) : null);
    const facts = writeOutFacts(outcome, opts, raw, urlNum, exitCode, errorMsg, elapsed, effectiveName);
    flushWriteOut(host, applyWriteOut(opts.writeOut, facts), stdoutParts, stderrLines);
  }

  return { output: stdoutParts.join(''), exitCode, stderr: stderrLines.join('\n') };
}

/**
 * Ce que `curl --version` annonce.
 *
 * La liste des protocoles est celle que ce simulateur SERT réellement,
 * et non celle du vrai curl : recopier `ftp gopher imap ldap …` ferait
 * annoncer une vingtaine de schémas que la commande refuse deux lignes
 * plus bas. Même règle pour les fonctionnalités.
 */
function versionBanner(): string {
  return [
    `${CURL_USER_AGENT.replace('/', ' ')} (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3`,
    'Release-Date: 2023-12-06',
    'Protocols: ftp http https',
    // Ce que ce curl SAIT faire, et rien d'autre. Recopier la ligne du
    // vrai (`HTTPS-proxy TLS-SRP UnixSockets…`) annoncerait des
    // capacités que la commande refuse deux lignes plus bas — le décor
    // que ces PRD passent leur temps à retirer.
    'Features: IPv6 libz SSL',
  ].join('\n');
}

export async function runCurl(host: CurlHost, args: readonly string[]): Promise<CurlRun> {
  const parsed = parseCurlArgs(args);
  if (parsed.ok === false) return { output: '', exitCode: parsed.exitCode, stderr: parsed.message };

  const opts = parsed.options;
  if (opts.version) return { output: `${versionBanner()}\n`, exitCode: 0, stderr: '' };
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;

  for (const [urlNum, raw] of opts.urls.entries()) {
    const run = await runOneUrl(host, opts, raw, urlNum);
    if (run.output) stdout.push(run.output);
    if (run.stderr) stderr.push(run.stderr);
    if (run.exitCode !== 0) exitCode = run.exitCode;
  }

  return { output: stdout.join(''), exitCode, stderr: stderr.join('\n') };
}
