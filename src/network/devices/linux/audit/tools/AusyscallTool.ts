import { elfToMachine, MACH } from './AuditInterpret';
import { SYSCALL_TABLES } from './AuditSyscallTables';
import { ExitSignal, ToolOutput, type ToolResult } from './AuditToolHost';

const LAST_SYSCALL = 1400;
const DUMP_LIMIT = 8192;

const MACHINE_NAMES: ReadonlyArray<readonly [number, string]> = [
  [MACH.X86, 'i386'], [MACH.X86_64, 'x86_64'], [MACH.PPC64, 'ppc64'], [MACH.PPC64LE, 'ppc64le'], [MACH.PPC, 'ppc'], [MACH.S390X, 's390x'], [MACH.S390, 's390'],
  [MACH.ARM, 'armeb'], [MACH.AARCH64, 'aarch64'], [MACH.IO_URING, 'uring'],
];

const MACHINE_ALIASES: Readonly<Record<string, number>> = {
  i386: MACH.X86, i486: MACH.X86, i586: MACH.X86, i686: MACH.X86, x86_64: MACH.X86_64, ppc64: MACH.PPC64, ppc64le: MACH.PPC64LE, ppc: MACH.PPC,
  s390x: MACH.S390X, s390: MACH.S390, armeb: MACH.ARM, arm: MACH.ARM, armv5tejl: MACH.ARM, armv5tel: MACH.ARM, armv6l: MACH.ARM, armv7l: MACH.ARM,
  aarch64: MACH.AARCH64, armv8l: MACH.AARCH64, uring: MACH.IO_URING,
};

export interface AusyscallHost {
  machine(): string;
}

function machineToName(machine: number): string {
  return MACHINE_NAMES.find(([value]) => value === machine)?.[1] ?? '(null)';
}

function tableFor(machine: number): Readonly<Record<number, string>> | null {
  switch (machine) {
    case MACH.X86: return SYSCALL_TABLES.i386;
    case MACH.X86_64: return SYSCALL_TABLES.x86_64;
    case MACH.PPC64:
    case MACH.PPC64LE:
    case MACH.PPC: return SYSCALL_TABLES.ppc;
    case MACH.S390X: return SYSCALL_TABLES.s390x;
    case MACH.S390: return SYSCALL_TABLES.s390;
    case MACH.ARM: return SYSCALL_TABLES.arm;
    case MACH.AARCH64: return SYSCALL_TABLES.aarch64;
    case MACH.IO_URING: return SYSCALL_TABLES.uringop;
    default: return null;
  }
}

function syscallToName(number: number, machine: number): string | null {
  return tableFor(machine)?.[number] ?? null;
}

function nameToSyscall(name: string, machine: number): number {
  const table = tableFor(machine);
  if (table === null) return -1;
  const wanted = name.toLowerCase();
  for (const [value, candidate] of Object.entries(table)) if (candidate.toLowerCase() === wanted) return Number(value);
  return -1;
}

function determineMachine(argument: string, native: number): number {
  let bits: 'none' | '64' | '32' = 'none';
  let machine: number;
  const lower = argument.toLowerCase();
  if (lower === 'b64') {
    bits = '64';
    machine = native;
  } else if (lower === 'b32') {
    bits = '32';
    machine = native;
  } else {
    machine = MACHINE_ALIASES[argument] ?? -1;
    if (machine < 0) {
      const parsed = parseInt(argument, 16);
      machine = Number.isNaN(parsed) || !/^\s*(0[xX])?[0-9a-fA-F]/.test(argument) ? -1 : elfToMachine(parsed);
    }
  }
  if (machine < 0) return -4;
  if (bits === '32') {
    if (machine === MACH.X86_64) machine = MACH.X86;
    else if (machine === MACH.PPC64) machine = MACH.PPC;
    else if (machine === MACH.S390X) machine = MACH.S390;
    else if (machine === MACH.AARCH64) machine = MACH.ARM;
  }
  switch (machine) {
    case MACH.X86:
    case MACH.PPC:
    case MACH.S390:
    case MACH.ARM:
      if (bits === '64') return -6;
      break;
    case MACH.AARCH64:
    case MACH.PPC64LE:
      if (bits !== 'none' && bits !== '64') return -6;
      break;
    case MACH.X86_64:
    case MACH.PPC64:
    case MACH.S390X:
    case MACH.IO_URING:
      break;
    default:
      return -6;
  }
  return machine;
}

const isDigit = (text: string): boolean => /^[0-9]/.test(text);

export function runAusyscall(host: AusyscallHost, args: string[]): ToolResult {
  const out = new ToolOutput();
  const usage = (): never => {
    out.eprintf('usage: ausyscall [arch] name | number | --dump | --exact\n');
    throw new ExitSignal(1);
  };
  const failure = (message: string): never => {
    out.eprintf(message);
    throw new ExitSignal(1);
  };
  const run = (): number => {
    if (args.length + 1 > 4) {
      out.eprintf('Too many arguments\n');
      usage();
    } else if (args.length + 1 < 2) usage();
    let machine = -1;
    let syscallNumber = -1;
    let dump = false;
    let exact = false;
    let name: string | null = null;
    const native = MACHINE_ALIASES[host.machine()] ?? -1;
    for (const argument of args) {
      let found: number;
      if (isDigit(argument)) {
        if (syscallNumber !== -1) {
          out.eprintf('Two syscall numbers not allowed\n');
          usage();
        }
        syscallNumber = Number(BigInt.asIntN(32, BigInt(/^\d+/.exec(argument)?.[0] ?? '0')));
      } else if ((found = determineMachine(argument, native)) >= 0) {
        if (machine !== -1) {
          out.eprintf('Two machine types not allowed\n');
          usage();
        }
        machine = found;
      } else if (argument === '--dump') dump = true;
      else if (argument === '--exact') exact = true;
      else if (argument === 'alpha') failure('Alpha processor support is deprecated\n');
      else if (argument === 'ia64') out.eprintf('IA64 processor support is deprecated\n');
      else {
        if (name !== null) {
          out.eprintf('Two syscall names not allowed\n');
          usage();
        }
        name = argument;
      }
    }
    if (name === null && machine === MACH.IO_URING && args.length === 1) {
      machine = -1;
      name = args[0];
    }
    if (machine === -1) machine = native;
    if (machine === -1) {
      out.eprintf('Unable to detect machine type\n');
      return 1;
    }
    if (dump) {
      out.printf(`Using ${machineToName(machine)} syscall table:\n`);
      for (let i = 0; i < DUMP_LIMIT; i++) {
        const entry = syscallToName(i, machine);
        if (entry !== null) out.printf(`${i}\t${entry}\n`);
      }
      return 0;
    }
    if (name !== null) {
      if (exact) {
        const found = nameToSyscall(name, machine);
        if (found < 0) {
          out.eprintf(`Unknown syscall ${name} using ${machineToName(machine)} lookup table\n`);
          return 1;
        }
        out.printf(`${found}\n`);
      } else {
        let any = false;
        for (let i = 0; i < LAST_SYSCALL; i++) {
          const entry = syscallToName(i, machine);
          if (entry !== null && entry.toLowerCase().includes(name.toLowerCase())) {
            any = true;
            out.printf(`${entry.padEnd(18)} ${i}\n`);
          }
        }
        if (!any) {
          out.eprintf(`Unknown syscall ${name} using ${machineToName(machine)} lookup table\n`);
          return 1;
        }
      }
    } else if (syscallNumber !== -1) {
      const entry = syscallToName(syscallNumber, machine);
      if (entry === null) {
        out.eprintf(`Unknown syscall ${syscallNumber} using ${machineToName(machine)} lookup table\n`);
        return 1;
      }
      out.printf(`${entry}\n`);
    } else {
      out.eprintf('Error - either a syscall name or number must be given with an optional arch\n');
      return 1;
    }
    return 0;
  };
  let code: number;
  try {
    code = run();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    code = error.code;
  }
  return { stdout: out.stdout, stderr: out.stderr, exitCode: code, interleaved: out.interleaved };
}
