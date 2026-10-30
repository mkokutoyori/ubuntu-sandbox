import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

export interface NetCmdsStep {
  readonly cmd: string;
  readonly output: string;
  readonly status: number;
  readonly visible?: readonly number[];
}

export interface NetCmdsCase {
  readonly id: string;
  readonly setup: readonly string[];
  readonly steps: readonly NetCmdsStep[];
  readonly pids: readonly string[];
  readonly addresses: readonly string[];
  readonly settle: number;
  readonly recordedPids: Readonly<Record<string, number | null>>;
  readonly shellPid?: number;
  readonly baseline: string;
}

export interface NetCmdsFixture {
  readonly family: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly cases: readonly NetCmdsCase[];
}

export interface NetCmdsRun {
  readonly steps: readonly NetCmdsStep[];
  readonly pids: Readonly<Record<string, number | null>>;
  readonly shellPid: number;
  readonly baseline: string;
}

interface RootRunner {
  readonly executor: {
    runAsUser<T>(username: string, fn: () => Promise<T>): Promise<T>;
    readonly processMgr: {
      list(): readonly { readonly pid: number; readonly ppid: number }[];
      get(pid: number): { user: string; uid: number; gid: number; euid: number; egid: number; suid: number; sgid: number; fsuid: number; fsgid: number } | undefined;
    };
  };
}

function descendantsOf(pc: LinuxPC, root: number): number[] {
  const table = (pc as unknown as RootRunner).executor.processMgr.list();
  const found = new Set<number>([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of table) {
      if (!found.has(proc.pid) && found.has(proc.ppid)) {
        found.add(proc.pid);
        grew = true;
      }
    }
  }
  return [...found];
}

const EPHEMERAL_PORT_FIRST = 32768;

export function comparableOutput(text: string): string {
  return text
    .replace(/(Connection received on \S+ )(\d+)/g, (whole, head: string, port: string) => (Number(port) >= EPHEMERAL_PORT_FIRST ? `${head}<ephemeral>` : whole))
    .replace(/^\[\d+\][+-]?\s+(Done|Exit \d+|Terminated|Killed|Hangup|Running)\b.*\n?/gm, '')
    .replace(/^\[\d+\] \d+\n?/gm, '')
    .replace(/^\S+\.sh: line \d+:\s+\d+ (Done|Exit \d+|Terminated|Killed|Hangup)\b.*\n?/gm, '');
}

const DAEMONS = ['ssh', 'systemd-resolved', 'chrony', 'rsyslog', 'cron', 'atd', 'fail2ban', 'auditd', 'systemd-networkd'];
const STATUS_MARK = '@@RC ';
export const STEP_TIMEOUT_OUTPUT = '@@STEP-TIMEOUT';
const STEP_TIMEOUT_MS = 20000;

async function withinStepTimeout(run: Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(`${STEP_TIMEOUT_OUTPUT}\n${STATUS_MARK}-1`), STEP_TIMEOUT_MS); });
  try {
    return await Promise.race([run, expired]);
  } finally {
    clearTimeout(timer);
  }
}
const PIDS_MARK = '@@PIDS ';
const LAB_DIRECTORY = '/tmp/lab';

export async function replayNetCmdsCase(lab: NetCmdsCase): Promise<NetCmdsRun> {
  EquipmentRegistry.resetInstance();
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  const asRoot = (line: string): Promise<string> => (pc as unknown as RootRunner).executor.runAsUser('root', () => pc.executeCommand(line));
  await asRoot('export LANG=C');
  for (const daemon of DAEMONS) await asRoot(`systemctl stop ${daemon}`);
  for (const address of lab.addresses) await asRoot(`ip addr add ${address} dev eth0`);
  if (lab.addresses.length > 0) await asRoot('ip link set eth0 up');
  const baseline = await asRoot('ss -s');
  await asRoot(`mkdir -p ${LAB_DIRECTORY}`);
  const names = lab.pids;
  const script = [
    'set +m',
    `cd ${LAB_DIRECTORY}`,
    ...lab.setup,
    `sleep ${lab.settle}`,
    ...(names.length === 0 ? [] : [`echo "${PIDS_MARK}${names.map((name) => `${name}=$${name}`).join(' ')}"`]),
  ].join('\n');
  const setupOutput = await asRoot(script);
  const pids: Record<string, number | null> = {};
  for (const line of setupOutput.split('\n')) {
    if (!line.startsWith(PIDS_MARK)) continue;
    for (const pair of line.slice(PIDS_MARK.length).trim().split(/\s+/)) {
      const [name, value] = pair.split('=');
      pids[name] = /^\d+$/.test(value ?? '') ? Number(value) : null;
    }
  }
  const shellPid = Number((await asRoot('echo $$')).trim());
  const shell = (pc as unknown as RootRunner).executor.processMgr.get(shellPid);
  if (shell !== undefined) Object.assign(shell, { user: 'root', uid: 0, gid: 0, euid: 0, egid: 0, suid: 0, sgid: 0, fsuid: 0, fsgid: 0 });
  const steps: NetCmdsStep[] = [];
  for (const step of lab.steps) {
    const visible = descendantsOf(pc, shellPid);
    const raw = await withinStepTimeout(asRoot(`cd ${LAB_DIRECTORY}; ${step.cmd}\necho "${STATUS_MARK}$?"`));
    const at = raw.lastIndexOf(STATUS_MARK);
    const status = at < 0 ? -1 : Number(raw.slice(at + STATUS_MARK.length).trim());
    const output = at < 0 ? raw : raw.slice(0, at).replace(/\n$/, '');
    steps.push({ cmd: step.cmd, output, status, visible });
  }
  return { steps, pids, shellPid, baseline };
}
