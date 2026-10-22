import { GnuGetopt, END_OF_OPTIONS, type LongOption } from './GnuGetopt';
import { ToolOutput, type ToolResult } from './AuditToolHost';
import type { AuditdLaunchOptions, AuditdStartupState } from '../LinuxAuditDaemon';

export interface AuditdInvocation extends AuditdLaunchOptions {
  noFork: boolean;
}

export type AuditdParse = { readonly options: AuditdInvocation } | { readonly exitCode: number; readonly stderr: string };

export interface AuditdCommandHost {
  isRoot(): boolean;
  launch(options: AuditdLaunchOptions): { exitCode: number; stderr: string };
}

const STARTUP_STATES: readonly AuditdStartupState[] = ['disable', 'enable', 'nochange'];

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'foreground', hasArg: 0, val: 'f'.charCodeAt(0) },
  { name: 'allow_links', hasArg: 0, val: 'l'.charCodeAt(0) },
  { name: 'disable_fork', hasArg: 0, val: 'n'.charCodeAt(0) },
  { name: 'enable_state', hasArg: 1, val: 's'.charCodeAt(0) },
  { name: 'config_file', hasArg: 1, val: 'c'.charCodeAt(0) },
];

const USAGE = 'Usage: auditd [-f] [-l] [-n] [-s disable|enable|nochange] [-c <config_file>]\n';

export function parseAuditdArguments(args: string[]): AuditdParse {
  const argv = ['auditd', ...args];
  const options: AuditdInvocation = {
    configFile: '/etc/audit/auditd.conf', allowLinks: false, startup: 'enable', foreground: false, noFork: false,
  };
  let stderr = '';
  const failure = (text: string): AuditdParse => ({ exitCode: 2, stderr: `${stderr}${text}${USAGE}` });
  const getopt = new GnuGetopt(argv, 'flns:c:', LONG_OPTIONS, { program: 'auditd', write: (text) => { stderr += text; } });
  getopt.optind = 0;
  for (;;) {
    const got = getopt.next();
    if (got.code === END_OF_OPTIONS) break;
    switch (String.fromCharCode(got.code)) {
      case 'f':
        options.foreground = true;
        break;
      case 'l':
        options.allowLinks = true;
        break;
      case 'n':
        options.noFork = true;
        break;
      case 's': {
        const wanted = got.optarg ?? '';
        const found = STARTUP_STATES.find((state) => state.startsWith(wanted));
        if (found === undefined) return failure(`unknown startup mode '${wanted}'\n`);
        options.startup = found;
        break;
      }
      case 'c':
        options.configFile = `${got.optarg}/auditd.conf`;
        break;
      default:
        return failure('');
    }
  }
  if (getopt.optind < argv.length) return failure('');
  return { options };
}

export function runAuditdCommand(host: AuditdCommandHost, args: string[]): ToolResult {
  const out = new ToolOutput();
  const parsed = parseAuditdArguments(args);
  let exitCode: number;
  if (!('options' in parsed)) {
    out.eprintf(parsed.stderr);
    exitCode = parsed.exitCode;
  } else if (!host.isRoot()) {
    out.eprintf('You must be root or have capabilities to run this program.\n');
    exitCode = 4;
  } else {
    const result = host.launch(parsed.options);
    out.eprintf(result.stderr);
    exitCode = result.exitCode;
  }
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}
