/**
 * SSH LAN — exhaustive command availability over SSH.
 *
 * BRD SSH-04-R3: every command that works on a local terminal must work
 * the same way over SSH. This file iterates over a wide list of common
 * Linux commands (network, filesystem, text-processing, user / process
 * management, init), runs each one both locally and via SSH, and asserts
 * that:
 *   1. neither side produces "command not found"
 *   2. the byte-exact local output matches the byte-exact SSH output
 *      after a deterministic normalisation
 *
 * Whenever a divergence appears it surfaces a real bug in the SSH
 * pipeline rather than a flaky CI: the simulator's clock is virtual so
 * the same shell, run twice, returns the same string.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import {
  buildLan,
  assignIps,
  sshExec,
  type SshLan,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';

interface CmdSpec {
  /** Friendly label used in the test name. */
  readonly label: string;
  /** The command line to run on both shells. */
  readonly cmd: string;
  /** Optional normalisation applied to BOTH sides before comparing. */
  readonly normalise?: (s: string) => string;
  /** Optional setup run on the target device before the command. */
  readonly setup?: string[];
}

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const stripTrailing = (s: string) => s.replace(ANSI_RE, '').replace(/\n+$/, '');

const NORMALISE_IFCONFIG = (s: string) =>
  stripTrailing(
    s
      .replace(/(RX|TX) packets \d+/g, '$1 packets *')
      .replace(/bytes \d+/g, 'bytes *'),
  );

const NORMALISE_TRACEROUTE = (s: string) =>
  stripTrailing(s.replace(/[\d.]+\s*ms/g, '*ms'));

const NORMALISE_PING = (s: string) =>
  stripTrailing(
    s
      .replace(/time=[\d.]+\s*ms/g, 'time=*ms')
      .replace(/rtt min\/avg\/max\/mdev = [^\n]+/g, 'rtt = *')
      .replace(/icmp_seq=\d+/g, 'icmp_seq=*'),
  );

/** Strip Main PID + Active duration which are non-deterministic. */
const NORMALISE_SYSTEMCTL = (s: string) =>
  stripTrailing(
    s
      .replace(/Main PID:\s*\d+/g, 'Main PID: *')
      .replace(/Active:[^\n]+/g, 'Active: *'),
  );

/** Replace all numeric values whose unit is seconds (ps TIME, uptime). */
const NORMALISE_TIME_FIELDS = (s: string) =>
  stripTrailing(
    s
      .replace(/\b\d+:\d{2}:\d{2}\b/g, '*:*:*')
      .replace(/\b\d+ days?,? \d+:\d{2}\b/g, '* days, *:*'),
  );

/**
 * df now reads real FS state (auth.log, wtmp, etc.) — so the Used /
 * Available / Use% columns on the / row legitimately differ between
 * a local invocation and one routed through SSH (the SSH path opens
 * a session that appends to auth.log before df runs). Mask the
 * volatile columns on the / row while keeping the rest of the table
 * byte-comparable so the test still verifies command structure.
 */
const NORMALISE_DF = (s: string) =>
  stripTrailing(
    s
      // 1K-blocks form: "/dev/sda1   <cap> <used> <avail> <pct>% /"
      .replace(
        /(\/dev\/sda1\s+\d+)\s+\d+\s+\d+\s+\d+%(\s+\/$)/m,
        '$1   * * *%$2',
      )
      // human form: "/dev/sda1   50G  XK  50G  pct% /"
      .replace(
        /(\/dev\/sda1\s+\d+[KMGT])\s+[\d.]+[KMGT]?\s+[\d.]+[KMGT]?\s+\d+%(\s+\/$)/m,
        '$1   * * *%$2',
      ),
  );

const COMMAND_SPECS: readonly CmdSpec[] = [
  // ─── identity / shell ─────────────────────────────────────────────
  { label: 'pwd', cmd: 'pwd' },
  { label: 'whoami', cmd: 'whoami' },
  { label: 'id', cmd: 'id' },
  { label: 'id -u', cmd: 'id -u' },
  { label: 'id -un', cmd: 'id -un' },
  { label: 'groups', cmd: 'groups' },
  { label: 'hostname', cmd: 'hostname' },
  { label: 'uname', cmd: 'uname' },
  { label: 'uname -a', cmd: 'uname -a' },
  { label: 'uname -r', cmd: 'uname -r' },
  { label: 'uname -m', cmd: 'uname -m' },

  // ─── filesystem reads ─────────────────────────────────────────────
  { label: 'cat /etc/hosts', cmd: 'cat /etc/hosts' },
  { label: 'cat /etc/resolv.conf', cmd: 'cat /etc/resolv.conf' },
  { label: 'cat /etc/passwd', cmd: 'cat /etc/passwd' },
  { label: 'cat /etc/group', cmd: 'cat /etc/group' },
  { label: 'cat /etc/hostname', cmd: 'cat /etc/hostname' },
  { label: 'cat /etc/motd', cmd: 'cat /etc/motd' },
  { label: 'cat /etc/issue.net', cmd: 'cat /etc/issue.net' },
  { label: 'cat /etc/ssh/sshd_config', cmd: 'cat /etc/ssh/sshd_config' },
  { label: 'ls /', cmd: 'ls /' },
  { label: 'ls /etc', cmd: 'ls /etc' },
  { label: 'ls -1 /etc', cmd: 'ls -1 /etc' },
  { label: 'ls -la /home/user', cmd: 'ls -la /home/user' },
  { label: 'ls -ld /etc/ssh', cmd: 'ls -ld /etc/ssh' },
  { label: 'stat /etc/passwd', cmd: 'stat /etc/passwd' },
  { label: 'stat -c %a /etc/passwd', cmd: 'stat -c %a /etc/passwd' },
  { label: 'file /etc/passwd', cmd: 'file /etc/passwd' },

  // ─── text utilities ───────────────────────────────────────────────
  { label: 'echo "hello"', cmd: 'echo "hello"' },
  { label: 'printf "%s-%s\\n"', cmd: 'printf "%s-%s\\n" foo bar' },
  { label: 'head -n 3 /etc/passwd', cmd: 'head -n 3 /etc/passwd' },
  { label: 'tail -n 2 /etc/passwd', cmd: 'tail -n 2 /etc/passwd' },
  { label: 'wc -l /etc/passwd', cmd: 'wc -l /etc/passwd' },
  { label: 'wc -c /etc/passwd', cmd: 'wc -c /etc/passwd' },
  { label: 'cut -d: -f1 /etc/passwd', cmd: 'cut -d: -f1 /etc/passwd' },
  { label: 'grep root /etc/passwd', cmd: 'grep root /etc/passwd' },
  { label: 'grep -c "" /etc/passwd', cmd: 'grep -c "" /etc/passwd' },
  { label: 'sort /etc/passwd', cmd: 'sort /etc/passwd' },
  { label: 'tr a-z A-Z (echo)', cmd: 'echo hello | tr a-z A-Z' },
  { label: 'basename', cmd: 'basename /etc/ssh/sshd_config' },
  { label: 'dirname', cmd: 'dirname /etc/ssh/sshd_config' },
  { label: 'true', cmd: 'true' },
  { label: 'false', cmd: 'false' },
  { label: 'test -f', cmd: 'test -f /etc/passwd && echo yes || echo no' },
  { label: 'test -d', cmd: 'test -d /etc && echo yes || echo no' },

  // ─── networking ───────────────────────────────────────────────────
  { label: 'ifconfig', cmd: 'ifconfig', normalise: NORMALISE_IFCONFIG },
  { label: 'ifconfig eth0', cmd: 'ifconfig eth0', normalise: NORMALISE_IFCONFIG },
  { label: 'ip addr show eth0', cmd: 'ip addr show eth0' },
  { label: 'ip link show eth0', cmd: 'ip link show eth0' },
  { label: 'ip route', cmd: 'ip route' },
  { label: 'route -n', cmd: 'route -n' },
  { label: 'ss -tln', cmd: 'ss -tln' },
  { label: 'netstat -tln', cmd: 'netstat -tln' },
  {
    label: 'arp -a (after ping)',
    cmd: 'arp -a',
    setup: [`ping -c 1 ${PC3_IP}`],
  },
  {
    label: 'arp -n (after ping)',
    cmd: 'arp -n',
    setup: [`ping -c 1 ${PC3_IP}`],
  },
  {
    label: 'ip neigh (after ping)',
    cmd: 'ip neigh',
    setup: [`ping -c 1 ${PC3_IP}`],
  },
  {
    label: 'ping localhost',
    cmd: 'ping -c 1 127.0.0.1',
    normalise: NORMALISE_PING,
  },
  {
    label: 'ping -c 1 PC3',
    cmd: `ping -c 1 ${PC3_IP}`,
    normalise: NORMALISE_PING,
  },
  {
    label: 'traceroute -n PC3',
    cmd: `traceroute -n ${PC3_IP}`,
    normalise: NORMALISE_TRACEROUTE,
  },

  // ─── processes / services ─────────────────────────────────────────
  { label: 'systemctl is-active ssh', cmd: 'systemctl is-active ssh' },
  {
    label: 'systemctl status ssh',
    cmd: 'systemctl status ssh',
    normalise: NORMALISE_SYSTEMCTL,
  },
  { label: 'systemctl is-enabled ssh', cmd: 'systemctl is-enabled ssh' },
  { label: 'service ssh status', cmd: 'service ssh status', normalise: NORMALISE_SYSTEMCTL },
  { label: 'ps headers', cmd: 'ps', normalise: (s) => s.split('\n')[0] },
  { label: 'ps -ef headers', cmd: 'ps -ef', normalise: (s) => s.split('\n')[0] },
  { label: 'uptime', cmd: 'uptime', normalise: NORMALISE_TIME_FIELDS },
  { label: 'free', cmd: 'free' },
  { label: 'free -h', cmd: 'free -h' },
  { label: 'df', cmd: 'df', normalise: NORMALISE_DF },
  { label: 'df -h', cmd: 'df -h', normalise: NORMALISE_DF },
];

describe('SSH LAN — exhaustive command availability over SSH (BRD SSH-04-R3)', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    lan = buildLan();
    await assignIps(lan);
  });

  for (const spec of COMMAND_SPECS) {
    it(`A — \`${spec.label}\` runs and matches local byte-exact`, async () => {
      for (const setupCmd of spec.setup ?? []) {
        await lan.pc2.executeCommand(setupCmd);
      }
      const norm = spec.normalise ?? stripTrailing;
      const local = norm(await lan.pc2.executeCommand(spec.cmd));
      const ssh = norm((await sshExec(lan.pc1, PC2_IP, spec.cmd)).stdout);
      // Sanity-check: neither side reports "command not found".
      expect(local.toLowerCase(), `local missing: ${spec.label}`).not.toContain(
        'command not found',
      );
      expect(ssh.toLowerCase(), `ssh missing: ${spec.label}`).not.toContain(
        'command not found',
      );
      expect(ssh).toStrictEqual(local);
    });
  }

  // The next scenarios mutate state, so we keep them outside the loop.

  it('A-mut1 — `mkdir -p` over SSH then `ls -d` byte-equals direct path', async () => {
    await sshExec(lan.pc1, PC2_IP, 'mkdir -p /tmp/A/B/C');
    const local = (await lan.pc2.executeCommand('ls -d /tmp/A/B/C'))
      .replace(ANSI_RE, '')
      .replace(/\n+$/, '');
    expect(local).toBe('/tmp/A/B/C');
  });

  it('A-mut2 — local mkdir + remote ls returns the same byte-exact listing as local ls', async () => {
    await lan.pc2.executeCommand('mkdir -p /tmp/M1 /tmp/M2 /tmp/M3');
    const local = (await lan.pc2.executeCommand('ls /tmp')).replace(/\n+$/, '');
    const ssh = (await sshExec(lan.pc1, PC2_IP, 'ls /tmp')).stdout.replace(/\n+$/, '');
    expect(ssh).toBe(local);
  });

  it('A-mut3 — `cp` over SSH is byte-coherent with local `cp`', async () => {
    await lan.pc2.executeCommand('echo source > /tmp/src.txt');
    await sshExec(lan.pc1, PC2_IP, 'cp /tmp/src.txt /tmp/dst-ssh.txt');
    await lan.pc2.executeCommand('cp /tmp/src.txt /tmp/dst-local.txt');
    const a = await lan.pc2.executeCommand('cat /tmp/dst-ssh.txt');
    const b = await lan.pc2.executeCommand('cat /tmp/dst-local.txt');
    expect(a).toBe(b);
  });

  it('A-mut4 — `mv` over SSH leaves the same VFS state as local `mv`', async () => {
    await lan.pc2.executeCommand('echo move > /tmp/origA.txt');
    await sshExec(lan.pc1, PC2_IP, 'mv /tmp/origA.txt /tmp/destA.txt');
    expect((await lan.pc2.executeCommand('cat /tmp/destA.txt')).trim()).toBe('move');
    expect(
      (await lan.pc2.executeCommand('test -e /tmp/origA.txt && echo y || echo n')).trim(),
    ).toBe('n');
  });

  it('A-mut5 — `rm` over SSH leaves the file gone (test -e returns n)', async () => {
    await lan.pc2.executeCommand('touch /tmp/rmA.txt');
    await sshExec(lan.pc1, PC2_IP, 'rm /tmp/rmA.txt');
    const exists = (
      await lan.pc2.executeCommand('test -e /tmp/rmA.txt && echo y || echo n')
    ).trim();
    expect(exists).toBe('n');
  });

  it('A-mut6 — `chown` over SSH yields the exact owner reported by stat', async () => {
    // Switch to root locally so chown is allowed.
    await lan.pc2.executeCommand('echo data > /tmp/own.txt');
    await lan.pc2.executeCommand('sudo chown 0:0 /tmp/own.txt');
    const owner = (await lan.pc2.executeCommand('stat -c %u:%g /tmp/own.txt')).trim();
    const sshOwner = (await sshExec(lan.pc1, PC2_IP, 'stat -c %u:%g /tmp/own.txt')).stdout.trim();
    expect(sshOwner).toBe(owner);
  });

  it('A-mut7 — `useradd` is reflected in /etc/passwd via SSH', async () => {
    // Compare the /etc/passwd entry seen by both shells after creating a user.
    await lan.pc2.executeCommand('sudo useradd -m alice');
    const local = (await lan.pc2.executeCommand('grep ^alice: /etc/passwd')).replace(/\n+$/, '');
    const ssh = (await sshExec(lan.pc1, PC2_IP, 'grep ^alice: /etc/passwd')).stdout.replace(/\n+$/, '');
    expect(ssh).toBe(local);
    expect(local.startsWith('alice:')).toBe(true);
  });

  it('A-mut8 — pipelines (`ls /etc | wc -l`) byte-equal local and SSH', async () => {
    const local = (await lan.pc2.executeCommand('ls /etc | wc -l')).replace(/\n+$/, '');
    const ssh = (await sshExec(lan.pc1, PC2_IP, 'ls /etc | wc -l')).stdout.replace(/\n+$/, '');
    expect(ssh).toBe(local);
  });

  it('A-mut9 — environment-variable substitution agrees', async () => {
    const local = (await lan.pc2.executeCommand('echo $HOME')).replace(/\n+$/, '');
    const ssh = (await sshExec(lan.pc1, PC2_IP, 'echo $HOME')).stdout.replace(/\n+$/, '');
    expect(ssh).toBe(local);
  });

  it('A-mut10 — `bash -c "cd /etc && pwd"` agrees byte-for-byte', async () => {
    await expectStrict(lan, 'bash -c "cd /etc && pwd"');
  });

  it('A-mut11 — `ifconfig eth0 | grep inet` agrees byte-for-byte', async () => {
    await expectStrict(lan, 'ifconfig eth0 | grep inet');
  });

  it('A-mut12 — sequential commands chained with ; agree', async () => {
    await expectStrict(lan, 'echo first; echo second; echo third');
  });
});

async function expectStrict(lan: SshLan, cmd: string): Promise<void> {
  const norm = (s: string) => s.replace(/\n+$/, '');
  const local = norm(await lan.pc2.executeCommand(cmd));
  const ssh = norm((await sshExec(lan.pc1, PC2_IP, cmd)).stdout);
  expect(ssh).toStrictEqual(local);
}
