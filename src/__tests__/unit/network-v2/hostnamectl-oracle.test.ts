/*
 * hostnamectl against the real tool and the real daemon (systemd 255.4-1ubuntu8.18 of Ubuntu 24.04): scripts/oracle/record_hostnamectl.py starts, in a private mount, UTS and PID namespace, a D-Bus
 * daemon with the real systemd-hostnamed and the real polkitd on it, plus fake_systemd1.py in the place of the systemd manager (hostnamectl status asks it for Virtualization and Architecture), and runs
 * the real hostnamectl 260 times over 14 scenarios, as root or as nobody. For each run it stores stdout, stderr and the status, and then what the daemon did: /etc/hostname, /etc/machine-info, the kernel
 * host name and the lines hostnamed logged (the journal of a real machine). The replay builds a LinuxPC with the same files, host name, os-release and virtualization and compares all of it; the machine ID,
 * the boot ID and the kernel release and version, which belong to the machine of the recording, are masked on both sides.
 * What the recording measured: status is a vertical table whose labels carry their colon and are right-aligned on the longest one; the rows are conditional (Pretty and Transient hostname only when
 * they differ from the static one, Static hostname `(unset)` when /etc/hostname is empty, Chassis with its glyph); /etc/hostname is read line by line (comments and blanks skipped, the first line
 * cleaned of anything but letters, digits, hyphens and dots) and the chassis falls back on the virtualization (vm, container); a valid name given without --static/--transient/--pretty clears the pretty
 * hostname and becomes the static and the kernel one, any other becomes the pretty one and its cleaned form the static one (64 bytes at most); the daemon refuses with the wording of
 * hostnamed.c (Invalid hostname, Invalid static hostname, Invalid pretty hostname, Invalid icon name, Invalid chassis, Invalid deployment, Invalid location), writes /etc/machine-info through an env-file
 * writer that quotes what needs it and keeps the keys it does not know, logs `Hostname set to <NAME> (static|transient|default)` and `Changed WHAT to 'VALUE'` (`'n/a'` when cleared); a caller who is not
 * root meets polkit and gets `Interactive authentication required.` unless the daemon has nothing to change; an unknown verb is answered with the closest known one (prefix first, then Levenshtein distance
 * of 5 at most); -M names a container the machine does not have and -H a host that cannot be reached.
 * What the recording could not reach: the Hardware and Firmware rows (the sandbox has no DMI table hostnamed accepts), OS Support End and --host/--machine on a machine that exists; they are in TODO.md.
 * Measured before the change (git stash push -- src/network src/powershell): 14 of 14 scenarios fail with every one of the 260 invocations different (the old command knew set-hostname and a status without
 * Pretty hostname, Transient hostname, Deployment, Location, JSON or any refusal; it printed a status with two spaces too many and the architecture x86_64 where systemd says x86-64); the WITNESS passes either
 * way, it only counts the fixture.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { SystemIdentity } from '@/network/devices/host/identity/SystemIdentity';

interface Run {
  readonly argv: readonly string[];
  readonly uid: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly rc: number;
  readonly etc_hostname: string | null;
  readonly machine_info: string | null;
  readonly kernel: string;
  readonly log: readonly string[];
}
interface Setup {
  readonly name: string;
  readonly etc_hostname: string | null;
  readonly machine_info: string | null;
  readonly kernel: string;
  readonly virt: string;
  readonly arch: string;
  readonly os_release: string;
}
interface Scenario { readonly setup: Setup; readonly runs: readonly Run[] }

interface Executor {
  readonly vfs: VirtualFileSystem;
  readonly identity: SystemIdentity;
  runAsUser<T>(user: string, work: () => Promise<T>): Promise<T>;
  setKernelHostname(name: string): void;
  logMgr: { journalMessagesOf?: (unit: string) => string[] };
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/hostnamectl-255.4.json', import.meta.url), 'utf8')) as { readonly scenarios: readonly Scenario[] };

const MACHINE_ARCHITECTURE: Readonly<Record<string, string>> = { 'x86-64': 'x86_64', arm64: 'aarch64', x86: 'i686' };
const NOBODY = 65534;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const executorOf = (pc: LinuxPC): Executor => (pc as unknown as { executor: Executor }).executor;

function build(setup: Setup): LinuxPC {
  const pc = new LinuxPC('H', 0, 0);
  const executor = executorOf(pc);
  const vfs = executor.vfs;
  if (setup.etc_hostname === null) vfs.deleteFile('/etc/hostname');
  else vfs.writeFile('/etc/hostname', setup.etc_hostname, 0, 0, 0o022);
  if (setup.machine_info !== null) vfs.writeFile('/etc/machine-info', setup.machine_info, 0, 0, 0o022);
  vfs.writeFile('/etc/os-release', setup.os_release, 0, 0, 0o022);
  executor.setKernelHostname(setup.kernel);
  executor.identity.virtualization = setup.virt;
  executor.identity.kernel.machine = MACHINE_ARCHITECTURE[setup.arch] ?? setup.arch;
  return pc;
}

const masked = (text: string): string => text
  .replace(/\b[0-9a-f]{32}\b/g, 'ID128')
  .replace(/Linux \S+/g, 'Linux RELEASE')
  .replace(/"KernelRelease"\s*:\s*"[^"]*"/g, '"KernelRelease":"RELEASE"')
  .replace(/"KernelVersion"\s*:\s*"[^"]*"/g, '"KernelVersion":"VERSION"')
  .replace(/systemd 255 \(255\.4-1ubuntu8\.\d+\)/g, 'systemd 255 (255.4-1ubuntuN)');

const shellWord = (word: string): string => (word === '' || /[^A-Za-z0-9_./=:@%+,-]/.test(word) ? `'${word.replace(/'/g, `'\\''`)}'` : word);

async function replay(pc: LinuxPC, run: Run): Promise<{ stdout: string; stderr: string; rc: number }> {
  const out = `/tmp/replay.${run.uid}.out`;
  const err = `/tmp/replay.${run.uid}.err`;
  const script = `hostnamectl ${run.argv.map(shellWord).join(' ')} 2>${err} >${out}; echo "rc=$?"; cat ${out}; echo ---; cat ${err}`;
  const text = await executorOf(pc).runAsUser(run.uid === 0 ? 'root' : 'nobody', () => pc.executeCommand(script));
  const [head, ...rest] = text.split('\n');
  const body = rest.join('\n');
  const split = body.lastIndexOf('---');
  return { rc: Number(head.replace('rc=', '')), stdout: body.slice(0, split), stderr: body.slice(split + 4) };
}

async function journalOf(pc: LinuxPC): Promise<string[]> {
  const text = await executorOf(pc).runAsUser('root', () => pc.executeCommand("journalctl -u systemd-hostnamed --no-pager -o cat"));
  return text.split('\n').filter((line) => line !== '');
}

describe('hostnamectl against the real tool and daemon', () => {
  it('WITNESS: the fixture holds the recorded scenarios, a refusal, a non-root run and a logged change', () => {
    expect(fixture.scenarios).toHaveLength(14);
    const runs = fixture.scenarios.flatMap((scenario) => scenario.runs);
    expect(runs).toHaveLength(260);
    expect(runs.some((run) => run.uid === NOBODY && run.stderr.includes('Interactive authentication required.'))).toBe(true);
    expect(runs.some((run) => run.log.some((line) => line.startsWith('Hostname set to')))).toBe(true);
    expect(runs.some((run) => run.stderr.startsWith('Unknown command verb'))).toBe(true);
  });

  for (const scenario of fixture.scenarios) {
    it(`${scenario.setup.name}: every invocation prints, returns and changes what the real tool does`, async () => {
      const pc = build(scenario.setup);
      const differing: string[] = [];
      let seenLog = (await journalOf(pc)).length;
      for (const run of scenario.runs) {
        const got = await replay(pc, run);
        const files = {
          etc_hostname: await executorOf(pc).runAsUser('root', () => pc.executeCommand('cat /etc/hostname 2>/dev/null; echo "[$?]"')),
          machine_info: await executorOf(pc).runAsUser('root', () => pc.executeCommand('cat /etc/machine-info 2>/dev/null; echo "[$?]"')),
          kernel: await executorOf(pc).runAsUser('root', () => pc.executeCommand('cat /proc/sys/kernel/hostname')),
        };
        const journal = await journalOf(pc);
        const logged = journal.slice(seenLog);
        seenLog = journal.length;
        const expectedFile = (text: string | null): string => (text === null ? '[1]' : `${text}[0]`);
        const normal = (text: string): string => masked(text).replace(/\n$/, '');
        const problems: string[] = [];
        if (normal(got.stdout) !== normal(run.stdout)) problems.push(`stdout ${JSON.stringify(normal(got.stdout))} != ${JSON.stringify(normal(run.stdout))}`);
        if (normal(got.stderr) !== normal(run.stderr)) problems.push(`stderr ${JSON.stringify(normal(got.stderr))} != ${JSON.stringify(normal(run.stderr))}`);
        if (got.rc !== run.rc) problems.push(`rc ${got.rc} != ${run.rc}`);
        if (normal(files.etc_hostname) !== normal(expectedFile(run.etc_hostname))) problems.push(`/etc/hostname ${JSON.stringify(files.etc_hostname)} != ${JSON.stringify(expectedFile(run.etc_hostname))}`);
        if (normal(files.machine_info) !== normal(expectedFile(run.machine_info))) problems.push(`/etc/machine-info ${JSON.stringify(files.machine_info)} != ${JSON.stringify(expectedFile(run.machine_info))}`);
        if (normal(files.kernel) !== run.kernel) problems.push(`kernel ${JSON.stringify(files.kernel)} != ${JSON.stringify(run.kernel)}`);
        if (JSON.stringify(logged) !== JSON.stringify(run.log)) problems.push(`log ${JSON.stringify(logged)} != ${JSON.stringify(run.log)}`);
        if (problems.length > 0) differing.push(`hostnamectl ${run.argv.join(' ')} (uid ${run.uid})\n  ${problems.join('\n  ')}`);
      }
      expect(differing, `${differing.length} of ${scenario.runs.length} differ\n${differing.join('\n')}`).toEqual([]);
    }, 300000);
  }
});
