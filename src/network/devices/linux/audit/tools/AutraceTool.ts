import { ToolOutput, type ToolResult } from './AuditToolHost';

export interface AutraceHost {
  isRoot(): boolean;
  executableState(path: string): 'executable' | 'missing' | 'denied';
  loadedRuleCount(): number;
  auditctl(args: string[]): ToolResult;
  startChild(argv: string[]): number;
  runChild(pid: number, argv: string[]): { output: string; exitCode: number };
  endChild(pid: number, exitCode: number): void;
  terminateChild(pid: number): void;
  sleepSeconds(seconds: number): void;
}

const TRACED_FILE_SYSCALLS_LEGACY = [
  'open', 'creat', 'rename', 'unlink', 'mknod', 'mkdir', 'rmdir', 'chown', 'lchown', 'chmod', 'link', 'symlink', 'readlink',
];

const TRACED_SYSCALLS = [
  'openat', 'truncate', 'renameat', 'unlinkat', 'mknodat', 'mkdirat', 'chdir', 'fchownat', 'fchmodat', 'linkat', 'symlinkat',
  'readlinkat', 'execve', 'name_to_handle_at', 'openat2',
];

const TRACED_NETWORK_SYSCALLS = ['connect', 'bind', 'accept', 'sendto', 'recvfrom', 'accept4'];

function syscallSelection(threat: boolean): string {
  if (!threat) return 'all';
  return [...TRACED_FILE_SYSCALLS_LEGACY, ...TRACED_SYSCALLS, ...TRACED_NETWORK_SYSCALLS, 'sendfile'].join(',');
}

export function runAutrace(host: AutraceHost, argv: string[]): ToolResult & { interleaved: string } {
  const out = new ToolOutput();
  const code = new Autrace(host, out).run(argv);
  return { stdout: out.stdout, stderr: out.stderr, exitCode: code, interleaved: out.interleaved };
}

class Autrace {
  constructor(private readonly host: AutraceHost, private readonly out: ToolOutput) {}

  private usage(): number {
    this.out.eprintf('usage: autrace [-r] program\n');
    return 1;
  }

  private insertRule(selection: string, field: string): boolean {
    const result = this.host.auditctl(['-a', 'always,exit', '-S', selection, '-F', field]);
    if (result.exitCode === 0) return true;
    this.out.eprintf(`Error inserting audit rule for ${field}\n`);
    return false;
  }

  run(argv: string[]): number {
    if (argv.length < 1 || argv[0] === '-h') return this.usage();
    let index = 0;
    let threat = false;
    if (argv[0] === '-r') {
      threat = true;
      index++;
    }
    const program = argv[index];
    if (!this.host.isRoot()) {
      this.out.eprintf('You must be root or have capabilities to run this program.\n');
      return 1;
    }
    const state = this.host.executableState(program ?? '');
    if (state === 'missing') {
      this.out.eprintf(`Error - can't find: ${program}\n`);
      return 1;
    }
    if (state === 'denied') {
      this.out.eprintf(`Error checking ${program} (Permission denied)\n`);
      return 1;
    }
    if (this.host.loadedRuleCount() > 0) {
      this.out.eprintf("autrace cannot be run with rules loaded.\nPlease delete all rules using 'auditctl -D' if you really wanted to\nrun this command.\n");
      return 1;
    }
    const command = argv.slice(index);
    const pid = this.host.startChild(command);
    this.out.printf(`Waiting to execute: ${program}\n`);
    const selection = syscallSelection(threat);
    for (const field of [`pid=${pid}`, `ppid=${pid}`]) {
      if (this.insertRule(selection, field)) continue;
      this.host.terminateChild(pid);
      this.host.auditctl(['-D']);
      return 1;
    }
    this.host.sleepSeconds(1);
    const result = this.host.runChild(pid, command);
    this.out.printf(result.output === '' || result.output.endsWith('\n') ? result.output : `${result.output}\n`);
    this.host.endChild(pid, result.exitCode);
    this.out.printf('Cleaning up...\n');
    this.host.auditctl(['-D']);
    this.out.printf(`Trace complete. You can locate the records with 'ausearch -i -p ${pid}'\n`);
    return 0;
  }
}
