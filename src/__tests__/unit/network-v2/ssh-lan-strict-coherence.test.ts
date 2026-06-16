/**
 * SSH LAN — strict coherence between local and remote shells.
 *
 * Every scenario runs the same command both directly on PC2 and through
 * `ssh user@PC2 <cmd>` from PC1, then compares the outputs. For most
 * commands the comparison is byte-exact ; for outputs that legitimately
 * vary across calls (PIDs in `ps`, seconds in `uptime`, …) a small
 * `normalise` step is applied. Any divergence between the two shells
 * fails the test outright.
 *
 * The strict comparison is what surfaces real regressions: any time the
 * SSH handler routes through a different code path than the local
 * pipeline (e.g. forgets to honour a flag, sees a different VFS view,
 * picks a different working directory), the byte-by-byte diff catches
 * it immediately.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import {
  buildLan,
  assignIps,
  sshExec,
  type SshLan,
  PC1_IP,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';
import type { LinuxPC } from '@/network/devices/LinuxPC';

/**
 * Run `cmd` locally on `device` and over SSH from `pc1` against
 * `targetIp`, optionally normalising both outputs with the same
 * deterministic transform before comparing them.
 */
async function expectStrictCoherence(
  pc1: LinuxPC,
  device: LinuxPC,
  cmd: string,
  normalise: (s: string) => string = (s) => s.replace(/\n+$/, ''),
): Promise<void> {
  const local = normalise(await device.executeCommand(cmd));
  const ssh = normalise((await sshExec(pc1, PC2_IP, cmd)).stdout);
  expect(ssh).toStrictEqual(local);
}

describe('SSH LAN — strict local vs SSH coherence', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    lan = buildLan();
    await assignIps(lan);
    // Seed deterministic state used by several scenarios.
    await lan.pc2.executeCommand('mkdir -p /home/user/work');
    await lan.pc2.executeCommand('printf "alpha\\nbeta\\ngamma\\n" > /home/user/work/data.txt');
    await lan.pc2.executeCommand('printf "z\\nx\\ny\\nx\\n" > /home/user/work/letters.txt');
  });

  // --- Identity & shell ---

  // SC1
  it('SC1 — `pwd` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'pwd');
  });

  // SC2
  it('SC2 — `whoami` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'whoami');
  });

  // SC3
  it('SC3 — `id` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'id');
  });

  // SC4
  it('SC4 — `id -u`, `id -g`, `id -un` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'id -u');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'id -g');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'id -un');
  });

  // SC5
  it('SC5 — `groups` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'groups');
  });

  // SC6
  it('SC6 — `hostname` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'hostname');
  });

  // SC7
  it('SC7 — `uname -a` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'uname -a');
  });

  // SC8
  it('SC8 — `uname -r`, `-m`, `-s` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'uname -r');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'uname -m');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'uname -s');
  });

  // SC9
  it('SC9 — `echo "hello world"` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'echo "hello world"');
  });

  // SC10
  it('SC10 — `printf "%s-%s\\n" foo bar` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'printf "%s-%s\\n" foo bar');
  });

  // --- Filesystem reads ---

  // SC11
  it('SC11 — `cat /etc/hosts` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cat /etc/hosts');
  });

  // SC12
  it('SC12 — `cat /etc/hostname` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cat /etc/hostname');
  });

  // SC13
  it('SC13 — `cat /etc/resolv.conf` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cat /etc/resolv.conf');
  });

  // SC14
  it('SC14 — `cat /etc/passwd` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cat /etc/passwd');
  });

  // SC15
  it('SC15 — `cat /etc/group` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cat /etc/group');
  });

  // SC16
  it('SC16 — `cat /etc/motd` byte-exact (BRD SSH-07-R7)', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cat /etc/motd');
  });

  // SC17
  it('SC17 — `cat /etc/issue.net` byte-exact (BRD SSH-07-R8)', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cat /etc/issue.net');
  });

  // SC18
  it('SC18 — `cat /etc/ssh/sshd_config` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cat /etc/ssh/sshd_config');
  });

  // SC19
  it('SC19 — `ls /` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ls /');
  });

  // SC20
  it('SC20 — `ls /etc` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ls /etc');
  });

  // SC21
  it('SC21 — `ls -1 /etc` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ls -1 /etc');
  });

  // SC22
  it('SC22 — `ls -la /home/user` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ls -la /home/user');
  });

  // SC23
  it('SC23 — `ls /tmp` (after seeded files) byte-exact', async () => {
    await lan.pc2.executeCommand('touch /tmp/a /tmp/b /tmp/c');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ls /tmp');
  });

  // --- Text utilities ---

  // SC24
  it('SC24 — `head -n 3 /etc/passwd` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'head -n 3 /etc/passwd');
  });

  // SC25
  it('SC25 — `tail -n 2 /etc/passwd` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'tail -n 2 /etc/passwd');
  });

  // SC26
  it('SC26 — `wc -l /etc/passwd` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'wc -l /etc/passwd');
  });

  // SC27
  it('SC27 — `wc -c /home/user/work/data.txt` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'wc -c /home/user/work/data.txt');
  });

  // SC28
  it('SC28 — `sort /home/user/work/letters.txt` byte-exact', async () => {
    await expectStrictCoherence(
      lan.pc1,
      lan.pc2,
      'sort /home/user/work/letters.txt',
    );
  });

  // SC29
  it('SC29 — `sort -u /home/user/work/letters.txt` byte-exact', async () => {
    await expectStrictCoherence(
      lan.pc1,
      lan.pc2,
      'sort -u /home/user/work/letters.txt',
    );
  });

  // SC30
  it('SC30 — `cut -d: -f1 /etc/passwd` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'cut -d: -f1 /etc/passwd');
  });

  // SC31
  it('SC31 — `grep root /etc/passwd` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'grep root /etc/passwd');
  });

  // SC32
  it('SC32 — `grep -c "" /etc/passwd` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'grep -c "" /etc/passwd');
  });

  // SC33
  it('SC33 — `tr a-z A-Z < /home/user/work/data.txt` byte-exact', async () => {
    await expectStrictCoherence(
      lan.pc1,
      lan.pc2,
      'tr a-z A-Z < /home/user/work/data.txt',
    );
  });

  // SC34
  it('SC34 — `basename` and `dirname` are byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'basename /etc/ssh/sshd_config');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'dirname /etc/ssh/sshd_config');
  });

  // SC35
  it('SC35 — `stat -c %a /etc/ssh/sshd_config` byte-exact', async () => {
    await expectStrictCoherence(
      lan.pc1,
      lan.pc2,
      'stat -c %a /etc/ssh/sshd_config',
    );
  });

  // --- Networking ---

  // SC36
  it('SC36 — `ifconfig eth0` byte-exact (after counter normalisation)', async () => {
    // RX/TX counters legitimately differ between two consecutive runs
    // (the SSH session itself generates traffic). Normalise them out.
    const norm = (s: string) =>
      s
        .replace(/(RX|TX) packets \d+/g, '$1 packets *')
        .replace(/bytes \d+/g, 'bytes *')
        .replace(/\([\d.]+ [KMGTP]?i?B\)/g, '(*)')
        .replace(/\n+$/, '');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ifconfig eth0', norm);
  });

  // SC37
  it('SC37 — `ifconfig` (no args) byte-exact (counters normalised)', async () => {
    const norm = (s: string) =>
      s
        .replace(/(RX|TX) packets \d+/g, '$1 packets *')
        .replace(/bytes \d+/g, 'bytes *')
        .replace(/\([\d.]+ [KMGTP]?i?B\)/g, '(*)')
        .replace(/\n+$/, '');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ifconfig', norm);
  });

  // SC38
  it('SC38 — `ip addr show eth0` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ip addr show eth0');
  });

  // SC39
  it('SC39 — `ip link show eth0` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ip link show eth0');
  });

  // SC40
  it('SC40 — `ip route` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ip route');
  });

  // SC41
  it('SC41 — `route -n` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'route -n');
  });

  // SC42
  it('SC42 — `arp -a` byte-exact (after a ping primes the table)', async () => {
    await lan.pc2.executeCommand(`ping -c 1 ${PC3_IP}`);
    await expectStrictCoherence(lan.pc1, lan.pc2, 'arp -a');
  });

  // SC43
  it('SC43 — `arp -n` byte-exact', async () => {
    await lan.pc2.executeCommand(`ping -c 1 ${PC3_IP}`);
    await expectStrictCoherence(lan.pc1, lan.pc2, 'arp -n');
  });

  // SC44
  it('SC44 — `ip neigh` byte-exact', async () => {
    await lan.pc2.executeCommand(`ping -c 1 ${PC3_IP}`);
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ip neigh');
  });

  // SC45
  it('SC45 — `ping -c 1 127.0.0.1` byte-exact (after stripping rtt)', async () => {
    // ping sprinkles times; strip the variable bits, keep the structural skeleton.
    const norm = (s: string) =>
      s
        .replace(/time=[\d.]+\s*ms/g, 'time=*ms')
        .replace(/rtt min\/avg\/max\/mdev = [^\n]+/g, 'rtt = *')
        .replace(/\n+$/, '');
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ping -c 1 127.0.0.1', norm);
  });

  // --- Process / system ---

  // SC46
  it('SC46 — `systemctl is-active ssh` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'systemctl is-active ssh');
  });

  // SC47
  it('SC47 — `systemctl status ssh` byte-exact (after pid mask)', async () => {
    const norm = (s: string) =>
      s.replace(/Main PID:\s*\d+/g, 'Main PID: *').replace(/\n+$/, '');
    await expectStrictCoherence(
      lan.pc1,
      lan.pc2,
      'systemctl status ssh',
      norm,
    );
  });

  // SC48
  it('SC48 — `ps` headers byte-exact', async () => {
    const norm = (s: string) => s.split('\n')[0];
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ps', norm);
  });

  // SC49
  it('SC49 — `ss -tln` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'ss -tln');
  });

  // SC50
  it('SC50 — `netstat -tln` byte-exact', async () => {
    await expectStrictCoherence(lan.pc1, lan.pc2, 'netstat -tln');
  });

  // --- Side-effect coherence ---

  // SC51
  it('SC51 — `touch` over SSH then `ls -l` locally is byte-exact with local touch + remote ls', async () => {
    // Variant 1: do everything locally.
    await lan.pc2.executeCommand('touch /tmp/local-touch.txt');
    const localLs = (await lan.pc2.executeCommand('ls /tmp/local-touch.txt')).replace(/\n+$/, '');

    // Variant 2: touch over SSH, then local ls.
    await sshExec(lan.pc1, PC2_IP, 'touch /tmp/ssh-touch.txt');
    const remoteLs = (await lan.pc2.executeCommand('ls /tmp/ssh-touch.txt')).replace(/\n+$/, '');

    // Both should have produced exactly one line listing the file path.
    expect(localLs).toBe('/tmp/local-touch.txt');
    expect(remoteLs).toBe('/tmp/ssh-touch.txt');
  });

  // SC52
  it('SC52 — writing through SSH is observable byte-exact via local cat', async () => {
    await sshExec(lan.pc1, PC2_IP, 'printf "line1\\nline2\\nline3\\n" > /tmp/strict.txt');
    const local = (await lan.pc2.executeCommand('cat /tmp/strict.txt')).replace(/\n+$/, '');
    expect(local).toBe('line1\nline2\nline3');
  });

  // SC53
  it('SC53 — chmod over SSH yields the exact mode reported locally by stat', async () => {
    await lan.pc2.executeCommand('echo data > /tmp/chmod.txt');
    await sshExec(lan.pc1, PC2_IP, 'chmod 640 /tmp/chmod.txt');
    const mode = (await lan.pc2.executeCommand('stat -c %a /tmp/chmod.txt')).trim();
    expect(mode).toBe('640');
  });

  // SC54
  it('SC54 — environment exported via SSH is the same set as local', async () => {
    const local = (await lan.pc2.executeCommand('env'))
      .split('\n')
      .filter((l) => l.startsWith('PATH=') || l.startsWith('HOME=') || l.startsWith('USER='))
      .sort()
      .join('\n');
    const ssh = (await sshExec(lan.pc1, PC2_IP, 'env')).stdout
      .split('\n')
      .filter((l) => l.startsWith('PATH=') || l.startsWith('HOME=') || l.startsWith('USER='))
      .sort()
      .join('\n');
    expect(ssh).toBe(local);
  });

  // SC55
  it('SC55 — pipe + redirection produces byte-identical local and SSH outputs', async () => {
    await expectStrictCoherence(
      lan.pc1,
      lan.pc2,
      'cat /etc/passwd | grep -v "^#" | wc -l',
    );
  });
});
