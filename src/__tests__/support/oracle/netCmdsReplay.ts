import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

export interface NetCmdsStep {
  readonly cmd: string;
  readonly output: string;
  readonly status: number;
}

export interface NetCmdsCase {
  readonly id: string;
  readonly setup: readonly string[];
  readonly steps: readonly NetCmdsStep[];
  readonly pids: readonly string[];
  readonly addresses: readonly string[];
  readonly settle: number;
  readonly recordedPids: Readonly<Record<string, number | null>>;
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
  readonly baseline: string;
}

interface RootRunner {
  readonly executor: { runAsUser<T>(username: string, fn: () => Promise<T>): Promise<T> };
}

const DAEMONS = ['ssh', 'systemd-resolved', 'chrony', 'rsyslog', 'cron', 'atd', 'fail2ban', 'auditd', 'systemd-networkd'];
const STATUS_MARK = '@@RC ';
const PIDS_MARK = '@@PIDS ';
const LAB_DIRECTORY = '/tmp/lab';

export async function replayNetCmdsCase(lab: NetCmdsCase): Promise<NetCmdsRun> {
  EquipmentRegistry.resetInstance();
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  const asRoot = (line: string): Promise<string> => (pc as unknown as RootRunner).executor.runAsUser('root', () => pc.executeCommand(line));
  for (const daemon of DAEMONS) await asRoot(`systemctl stop ${daemon}`);
  for (const address of lab.addresses) await asRoot(`ip addr add ${address} dev eth0`);
  if (lab.addresses.length > 0) await asRoot('ip link set eth0 up');
  const baseline = await asRoot('ss -s');
  await asRoot(`mkdir -p ${LAB_DIRECTORY}`);
  const names = lab.pids;
  const script = [
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
  const steps: NetCmdsStep[] = [];
  for (const step of lab.steps) {
    const raw = await asRoot(`cd ${LAB_DIRECTORY}; ${step.cmd}\necho "${STATUS_MARK}$?"`);
    const at = raw.lastIndexOf(STATUS_MARK);
    const status = at < 0 ? -1 : Number(raw.slice(at + STATUS_MARK.length).trim());
    const output = at < 0 ? raw : raw.slice(0, at).replace(/\n$/, '');
    steps.push({ cmd: step.cmd, output, status });
  }
  return { steps, pids, baseline };
}
