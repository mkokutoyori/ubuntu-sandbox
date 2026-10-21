import { GnuGetopt, END_OF_OPTIONS, type LongOption } from './GnuGetopt';
import { ToolOutput, type ToolResult } from './AuditToolHost';
import type { AuditdLaunchOptions, AuditdStartupState } from '../LinuxAuditDaemon';

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

export function runAuditdCommand(host: AuditdCommandHost, args: string[]): ToolResult {
  const out = new ToolOutput();
  const exitCode = new AuditdCommand(host, out).run(args);
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}

class AuditdCommand {
  constructor(private readonly host: AuditdCommandHost, private readonly out: ToolOutput) {}

  private usage(): number {
    this.out.eprintf(USAGE);
    return 2;
  }

  run(args: string[]): number {
    const argv = ['auditd', ...args];
    const options: AuditdLaunchOptions = { configFile: '/etc/audit/auditd.conf', allowLinks: false, startup: 'enable', foreground: false };
    const getopt = new GnuGetopt(argv, 'flns:c:', LONG_OPTIONS, { program: 'auditd', write: (text) => this.out.eprintf(text) });
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
          break;
        case 's': {
          const wanted = got.optarg ?? '';
          const found = STARTUP_STATES.find((state) => state.startsWith(wanted));
          if (found === undefined) {
            this.out.eprintf(`unknown startup mode '${wanted}'\n`);
            return this.usage();
          }
          options.startup = found;
          break;
        }
        case 'c':
          options.configFile = `${got.optarg}/auditd.conf`;
          break;
        default:
          return this.usage();
      }
    }
    if (getopt.optind < argv.length) return this.usage();
    if (!this.host.isRoot()) {
      this.out.eprintf('You must be root or have capabilities to run this program.\n');
      return 4;
    }
    const result = this.host.launch(options);
    this.out.eprintf(result.stderr);
    return result.exitCode;
  }
}
