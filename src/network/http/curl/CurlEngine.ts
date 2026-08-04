import { parseCurlArgs, remoteNameFor, type CurlOptions } from './CurlArgs';
import { parseCurlUrl, performCurlRequest, type CurlOutcome, type CurlSuccess } from './CurlTransfer';
import { applyWriteOut, type WriteOutFacts } from './CurlWriteOut';
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

function headerBlock(outcome: CurlSuccess): string {
  const status = `HTTP/${outcome.httpVersion} ${outcome.statusCode} ${outcome.reasonPhrase}`.trimEnd();
  return [status, ...outcome.headers.map((h) => `${h.name}: ${h.value}`), ''].join('\n');
}

function contentTypeOf(outcome: CurlSuccess): string {
  return outcome.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
}

function writeOutFacts(
  outcome: CurlOutcome,
  opts: CurlOptions,
  requestedUrl: string,
  exitCode: number,
  errorMsg: string,
  elapsed: number,
): WriteOutFacts {
  if (outcome.ok === true) {
    return {
      httpCode: outcome.statusCode,
      urlEffective: outcome.url.effective,
      remoteIp: outcome.remoteIp,
      remotePort: outcome.url.port,
      sizeDownload: outcome.body.length,
      sizeUpload: opts.data.join('&').length,
      contentType: contentTypeOf(outcome),
      numRedirects: outcome.numRedirects,
      timeTotal: elapsed,
      method: outcome.method,
      scheme: outcome.url.scheme.toUpperCase(),
      httpVersion: outcome.httpVersion,
      exitCode,
      errorMsg,
      numHeaders: outcome.headers.length,
    };
  }
  return {
    httpCode: 0,
    urlEffective: outcome.url?.effective ?? requestedUrl,
    remoteIp: outcome.remoteIp,
    remotePort: outcome.url?.port ?? 0,
    sizeDownload: 0,
    sizeUpload: opts.data.join('&').length,
    contentType: '',
    numRedirects: outcome.numRedirects,
    timeTotal: elapsed,
    method: outcome.method,
    scheme: (outcome.url?.scheme ?? 'http').toUpperCase(),
    httpVersion: '',
    exitCode,
    errorMsg,
    numHeaders: 0,
  };
}

function bareMessage(message: string): string {
  return message.replace(/^curl: \(\d+\) /, '');
}

async function runOneUrl(host: CurlHost, opts: CurlOptions, raw: string): Promise<CurlRun> {
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
        opts, raw, parsed.code, bareMessage(parsed.message), 0,
      );
      const rendered = applyWriteOut(opts.writeOut, facts);
      stdoutParts.push(rendered.text);
      stderrLines.push(...rendered.warnings);
    }
    return { output: stdoutParts.join(''), exitCode: parsed.code, stderr: stderrLines.join('\n') };
  }

  const started = Date.now();
  const outcome = await performCurlRequest(host, parsed.url, opts);
  const elapsed = (Date.now() - started) / 1000;

  if (opts.verbose) stderrLines.push(...outcome.trace);

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
    let target = opts.output;
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
    const facts = writeOutFacts(outcome, opts, raw, exitCode, errorMsg, elapsed);
    const rendered = applyWriteOut(opts.writeOut, facts);
    stdoutParts.push(rendered.text);
    stderrLines.push(...rendered.warnings);
  }

  return { output: stdoutParts.join(''), exitCode, stderr: stderrLines.join('\n') };
}

export async function runCurl(host: CurlHost, args: readonly string[]): Promise<CurlRun> {
  const parsed = parseCurlArgs(args);
  if (parsed.ok === false) return { output: '', exitCode: parsed.exitCode, stderr: parsed.message };

  const opts = parsed.options;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;

  for (const raw of opts.urls) {
    const run = await runOneUrl(host, opts, raw);
    if (run.output) stdout.push(run.output);
    if (run.stderr) stderr.push(run.stderr);
    if (run.exitCode !== 0) exitCode = run.exitCode;
  }

  return { output: stdout.join(''), exitCode, stderr: stderr.join('\n') };
}
