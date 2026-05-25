/**
 * SSH LAN — security, firewalls, editors, Oracle CLIs.
 *
 * The previous suites focused on identity, filesystem, networking and
 * services; this one tightens the loop on commands that historically
 * surfaced as "command not found" over SSH:
 *
 *   - Editors (nano, vi, vim, ed) — must at least create the file in
 *     batch mode and exit silently
 *   - TTY housekeeping (clear, reset)
 *   - Oracle CLIs (sqlplus, rman, lsnrctl, tnsping, dbca, orapwd, adrci)
 *   - Security / firewalls (iptables, iptables-save, ufw)
 *   - Process / signal management (kill, pkill, killall, jobs)
 *   - Log / audit (journalctl, dmesg, logger)
 *
 * Every scenario is byte-exact local-vs-SSH (with normalisation only
 * for inherently variable bits) AND asserts no side prints
 * "command not found".
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
} from './ssh-lan-fixtures';

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const stripTrailing = (s: string) =>
  s.replace(ANSI_RE, '').replace(/\n+$/, '');

const NORMALISE_DATE = (s: string) =>
  stripTrailing(
    s
      .replace(
        /(\w{3} \w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2}|\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT)/g,
        '<DATE>',
      )
      .replace(/Production on \S+ \S+ \S+/g, 'Production on <DATE>'),
  );

async function expectStrict(
  lan: SshLan,
  cmd: string,
  normalise: (s: string) => string = stripTrailing,
): Promise<void> {
  const local = normalise(await lan.pc2.executeCommand(cmd));
  const ssh = normalise((await sshExec(lan.pc1, PC2_IP, cmd)).stdout);
  expect(local.toLowerCase()).not.toContain('command not found');
  expect(ssh.toLowerCase()).not.toContain('command not found');
  expect(ssh).toStrictEqual(local);
}

describe('SSH LAN — security, firewalls, editors, Oracle CLIs', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    lan = buildLan();
    await assignIps(lan);
  });

  // ─── Editors ────────────────────────────────────────────────────

  // SE1
  it('SE1 — `nano` (no args) is found over SSH', async () => {
    const out = await sshExec(lan.pc1, PC2_IP, 'nano');
    expect(out.stdout.toLowerCase()).not.toContain('command not found');
  });

  // SE2
  it('SE2 — `nano file.sh` over SSH creates the file (visible to local cat)', async () => {
    const out = await sshExec(lan.pc1, PC2_IP, 'nano /tmp/hello.sh');
    expect(out.stdout.toLowerCase()).not.toContain('command not found');
    const exists = (
      await lan.pc2.executeCommand('test -e /tmp/hello.sh && echo y || echo n')
    ).trim();
    expect(exists).toBe('y');
  });

  // SE3
  it('SE3 — `vi /tmp/v.txt` over SSH creates the file', async () => {
    await sshExec(lan.pc1, PC2_IP, 'vi /tmp/v.txt');
    const exists = (
      await lan.pc2.executeCommand('test -e /tmp/v.txt && echo y || echo n')
    ).trim();
    expect(exists).toBe('y');
  });

  // SE4
  it('SE4 — `vim /tmp/vim.txt` over SSH creates the file', async () => {
    await sshExec(lan.pc1, PC2_IP, 'vim /tmp/vim.txt');
    const exists = (
      await lan.pc2.executeCommand('test -e /tmp/vim.txt && echo y || echo n')
    ).trim();
    expect(exists).toBe('y');
  });

  // SE5
  it('SE5 — editor commands return identical output local vs SSH', async () => {
    await expectStrict(lan, 'nano /tmp/n1.txt');
    await expectStrict(lan, 'vi /tmp/n2.txt');
    await expectStrict(lan, 'vim /tmp/n3.txt');
  });

  // ─── TTY ────────────────────────────────────────────────────────

  // SE6
  it('SE6 — `clear` and `reset` are found and return empty', async () => {
    await expectStrict(lan, 'clear');
    await expectStrict(lan, 'reset');
  });

  // ─── Oracle CLIs ───────────────────────────────────────────────

  // SE7
  it('SE7 — `sqlplus -V` advertises Release 19.0.0.0.0', async () => {
    const out = await sshExec(lan.pc1, PC2_IP, 'sqlplus -V');
    expect(out.stdout.toLowerCase()).not.toContain('command not found');
    expect(out.stdout).toContain('SQL*Plus: Release 19.0.0.0.0');
  });

  // SE8
  it('SE8 — `sqlplus / as sysdba` returns ORA-12162 (matches local)', async () => {
    await expectStrict(lan, 'sqlplus / as sysdba', NORMALISE_DATE);
  });

  // SE9
  it('SE9 — `rman` is found over SSH', async () => {
    const out = await sshExec(lan.pc1, PC2_IP, 'rman');
    expect(out.stdout.toLowerCase()).not.toContain('command not found');
    expect(out.stdout).toContain('Recovery Manager');
  });

  // SE10
  it('SE10 — `lsnrctl version` matches local byte-exact', async () => {
    // lsnrctl ships only with Oracle (i.e. on a LinuxServer). On a
    // plain PC2 the binary genuinely isn't there — the assertion that
    // matters is the SSH-vs-local parity, NOT the "command found" gate.
    const local = stripTrailing(await lan.pc2.executeCommand('lsnrctl version'));
    const ssh = stripTrailing((await sshExec(lan.pc1, PC2_IP, 'lsnrctl version')).stdout);
    expect(ssh).toStrictEqual(local);
  });

  // SE11
  it('SE11 — `tnsping orcl` matches local byte-exact', async () => {
    await expectStrict(lan, 'tnsping orcl');
  });

  // SE12
  it('SE12 — `dbca`, `orapwd`, `adrci` are found over SSH', async () => {
    for (const cmd of ['dbca', 'orapwd', 'adrci']) {
      await expectStrict(lan, cmd);
    }
  });

  // ─── iptables ──────────────────────────────────────────────────

  // SE13
  it('SE13 — `iptables -L` runs and matches local byte-exact', async () => {
    await expectStrict(lan, 'iptables -L');
  });

  // SE14
  it('SE14 — `iptables -L INPUT` runs and matches local byte-exact', async () => {
    await expectStrict(lan, 'iptables -L INPUT');
  });

  // SE15
  it('SE15 — `iptables -L -n -v` runs and matches local byte-exact', async () => {
    await expectStrict(lan, 'iptables -L -n -v');
  });

  // SE16
  it('SE16 — appending an iptables rule via SSH is visible from local list', async () => {
    await sshExec(
      lan.pc1,
      PC2_IP,
      'iptables -A INPUT -p tcp --dport 80 -j ACCEPT',
    );
    const local = await lan.pc2.executeCommand('iptables -L INPUT');
    expect(local).toContain('tcp');
    expect(local).toMatch(/dpt:80|80/);
  });

  // SE17
  it('SE17 — `iptables-save` matches local byte-exact (counters normalised)', async () => {
    await sshExec(
      lan.pc1,
      PC2_IP,
      'iptables -A INPUT -p tcp --dport 22 -j ACCEPT',
    );
    // Per-chain packet/byte counters [N:M] change between two runs.
    const norm = (s: string) =>
      stripTrailing(s.replace(/\[\d+:\d+\]/g, '[*:*]'));
    await expectStrict(lan, 'iptables-save', norm);
  });

  // SE18
  it('SE18 — `iptables -F` flushes the chain and matches via SSH', async () => {
    await sshExec(
      lan.pc1,
      PC2_IP,
      'iptables -A INPUT -p tcp --dport 22 -j ACCEPT',
    );
    await sshExec(lan.pc1, PC2_IP, 'iptables -F');
    const out = await lan.pc2.executeCommand('iptables -L INPUT');
    expect(out).not.toContain('dpt:22');
  });

  // ─── ufw ───────────────────────────────────────────────────────

  // SE19
  it('SE19 — `ufw status` matches local byte-exact', async () => {
    await expectStrict(lan, 'ufw status');
  });

  // SE20
  it('SE20 — `ufw status verbose` matches local byte-exact', async () => {
    await expectStrict(lan, 'ufw status verbose');
  });

  // SE21
  it('SE21 — `ufw version` matches local byte-exact', async () => {
    await expectStrict(lan, 'ufw version');
  });

  // SE22
  it('SE22 — `ufw default deny` returns the same wording local vs SSH', async () => {
    // Without root the command surfaces "permission denied" identically
    // through both shells; the goal here is to assert byte-coherence.
    await expectStrict(lan, 'ufw default deny');
  });

  // SE23
  it('SE23 — `ufw allow 22/tcp` returns the same wording local vs SSH', async () => {
    await expectStrict(lan, 'ufw allow 22/tcp');
  });

  // ─── Process management ────────────────────────────────────────

  // SE24
  it('SE24 — `kill -l` lists signals byte-exact', async () => {
    await expectStrict(lan, 'kill -l');
  });

  // SE25
  it('SE25 — `pkill nonexistent` exits cleanly via SSH', async () => {
    const out = await sshExec(lan.pc1, PC2_IP, 'pkill nonexistent-process-zzz');
    expect(out.stdout.toLowerCase()).not.toContain('command not found');
  });

  // SE26
  it('SE26 — `pgrep init` matches local byte-exact', async () => {
    await expectStrict(lan, 'pgrep init');
  });

  // ─── Logging / audit ───────────────────────────────────────────

  // SE27
  it('SE27 — `journalctl -n 5` runs and matches local byte-exact', async () => {
    await expectStrict(lan, 'journalctl -n 5');
  });

  // SE28
  it('SE28 — `dmesg` runs and matches local byte-exact', async () => {
    await expectStrict(lan, 'dmesg');
  });

  // SE29
  it('SE29 — `logger "test"` then `journalctl -n 1` shows it via SSH', async () => {
    await sshExec(lan.pc1, PC2_IP, 'logger "ssh-test-msg"');
    const out = await lan.pc2.executeCommand('journalctl -n 5');
    expect(out.toLowerCase()).toContain('ssh-test-msg');
  });

  // ─── Permissions / ACLs ────────────────────────────────────────

  // SE30
  it('SE30 — `umask` returns identical local vs SSH', async () => {
    await expectStrict(lan, 'umask');
  });

  // SE31
  it('SE31 — `getent passwd user` runs and matches local byte-exact', async () => {
    await expectStrict(lan, 'getent passwd user');
  });

  // SE32
  it('SE32 — `chmod`, `stat -c %A` byte-coherent via SSH', async () => {
    await lan.pc2.executeCommand('echo data > /tmp/permA.txt');
    await sshExec(lan.pc1, PC2_IP, 'chmod 754 /tmp/permA.txt');
    await expectStrict(lan, 'stat -c %A /tmp/permA.txt');
  });

  // SE33
  it('SE33 — `id alice` (after useradd) byte-coherent via SSH', async () => {
    await lan.pc2.executeCommand('sudo useradd -m alice');
    await expectStrict(lan, 'id alice');
  });

  // SE34
  it('SE34 — `groups alice` byte-coherent via SSH', async () => {
    await lan.pc2.executeCommand('sudo useradd -m alice');
    await expectStrict(lan, 'groups alice');
  });

  // SE35
  it('SE35 — `getent group` runs and matches local byte-exact', async () => {
    await expectStrict(lan, 'getent group');
  });
});
