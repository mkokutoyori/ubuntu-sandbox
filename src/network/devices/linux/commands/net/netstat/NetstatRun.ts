import { parseNetstatArguments, type NetstatOptions } from './NetstatArguments';
import {
  renderInternetConnections, renderUnixSockets, type NetstatInternetHost,
} from './NetstatInternet';

export interface NetstatHost extends NetstatInternetHost {
  programNotice(): string;
  routes(options: NetstatOptions): string;
  interfaces(options: NetstatOptions): string;
  statistics(options: NetstatOptions): string;
}

export interface NetstatResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stderrFirst?: boolean;
}

function unsupported(feature: string): NetstatResult {
  return { stdout: '', stderr: `netstat: no support for \`${feature}' on this system.\n`, exitCode: 1 };
}

export function runNetstat(args: readonly string[], host: NetstatHost): NetstatResult {
  const parsed = parseNetstatArguments(args);
  if (parsed.exit !== null) return parsed.exit;
  const options = parsed.options as NetstatOptions;
  if (options.masquerade) return unsupported('ip_masquerade');
  if (options.groups) return unsupported('AF INET (igmp)');
  if (options.statistics) return { stdout: host.statistics(options), stderr: '', exitCode: 0 };
  if (options.routes) return { stdout: host.routes(options), stderr: '', exitCode: 0 };
  if (options.interfaces) return { stdout: host.interfaces(options), stderr: '', exitCode: 0 };
  if (options.unsupportedFamilies.length > 0 && options.argumentCount === options.unsupportedFamilies.length) {
    return unsupported(`AF ${options.unsupportedFamilies[0].toUpperCase()}`);
  }

  const notice = options.programs ? host.programNotice() : '';
  const internet = renderInternetConnections(options, host, notice);
  const stderrFirst = notice !== '';
  if (internet.exitCode !== 0) {
    return { stdout: internet.text, stderr: internet.stderr, exitCode: internet.exitCode, stderrFirst };
  }
  let stdout = internet.text;
  let stderr = internet.stderr;
  if (options.argumentCount === 0 || options.unix) {
    const unix = renderUnixSockets(options, host, internet.text === '' ? notice : '');
    stdout += unix.text;
    stderr += unix.stderr;
    if (unix.exitCode !== 0) return { stdout, stderr, exitCode: unix.exitCode, stderrFirst };
  }
  return { stdout, stderr, exitCode: 0, stderrFirst };
}
