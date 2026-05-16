/**
 * SSH LAN — in-memory ssh-agent + `ssh-add`.
 *
 * Subsystems:
 *  - SshAgent: in-memory key cache, one per LinuxPC. Keys carry their
 *    fingerprint (`SHA256:<...>`) and the source path so `ssh-add -l`
 *    prints the same lines OpenSSH does.
 *  - `ssh-add` command: load default identities, list, delete.
 *
 * Scope:
 *  - A1..A3 : SshAgent add/list/remove round-trips.
 *  - A4     : addAll() seeds the standard identity files from a VFS.
 *  - A5..A8 : `ssh-add` CLI from a LinuxPC (no args, -l, -d, -D).
 *  - A9     : SHA256 fingerprint format matches `ssh-keygen -lf`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { SshAgent } from '@/network/protocols/ssh/SshAgent';

describe('SSH LAN — in-memory ssh-agent + ssh-add', () => {
  let pc: LinuxPC;
  let agent: SshAgent;

  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    pc = new LinuxPC('linux-pc', 'PC1');
    agent = new SshAgent();
  });

  // ─── SshAgent core ────────────────────────────────────────────

  // A1
  it('A1 — add() loads a private key from the VFS and indexes it by path', () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile(
      '/home/user/.ssh/id_ed25519',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAed25519test\n-----END OPENSSH PRIVATE KEY-----\n',
      1000, 1000, 0o077,
    );
    expect(agent.add('/home/user/.ssh/id_ed25519', vfs)).toBe(true);
    expect(agent.list().map((k) => k.path)).toEqual([
      '/home/user/.ssh/id_ed25519',
    ]);
  });

  // A2
  it('A2 — add() refuses a non-existent file (returns false, list unchanged)', () => {
    const vfs = pcVfs(pc);
    expect(agent.add('/home/user/.ssh/missing', vfs)).toBe(false);
    expect(agent.list()).toHaveLength(0);
  });

  // A3
  it('A3 — remove() drops a single key, removeAll() empties the cache', () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/user/.ssh/id_ed25519', 'k1', 1000, 1000, 0o077);
    vfs.writeFile('/home/user/.ssh/id_rsa', 'k2', 1000, 1000, 0o077);
    agent.add('/home/user/.ssh/id_ed25519', vfs);
    agent.add('/home/user/.ssh/id_rsa', vfs);
    expect(agent.remove('/home/user/.ssh/id_ed25519')).toBe(true);
    expect(agent.list().map((k) => k.path)).toEqual([
      '/home/user/.ssh/id_rsa',
    ]);
    agent.removeAll();
    expect(agent.list()).toHaveLength(0);
  });

  // A4
  it('A4 — addAll() seeds every default identity present in ~/.ssh/', () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/user/.ssh/id_ed25519', 'ed', 1000, 1000, 0o077);
    vfs.writeFile('/home/user/.ssh/id_rsa', 'rsa', 1000, 1000, 0o077);
    // id_ecdsa absent
    const added = agent.addAll('/home/user', vfs);
    expect(added).toEqual([
      '/home/user/.ssh/id_ed25519',
      '/home/user/.ssh/id_rsa',
    ]);
  });

  // A9
  it('A9 — fingerprint follows the SHA256:base64 shape', () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/user/.ssh/id_ed25519', 'material', 1000, 1000, 0o077);
    agent.add('/home/user/.ssh/id_ed25519', vfs);
    const [k] = agent.list();
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  // ─── `ssh-add` command ────────────────────────────────────────

  // A5
  it('A5 — `ssh-add` with no args loads the user\'s default identities', async () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/user/.ssh/id_ed25519', 'ed', 1000, 1000, 0o077);
    const out = await pc.executeCommand('ssh-add');
    expect(out).toMatch(/Identity added: \/home\/user\/\.ssh\/id_ed25519/);
  });

  // A6
  it('A6 — `ssh-add -l` lists the loaded fingerprints', async () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/user/.ssh/id_ed25519', 'ed', 1000, 1000, 0o077);
    await pc.executeCommand('ssh-add');
    const out = await pc.executeCommand('ssh-add -l');
    expect(out).toMatch(/256 SHA256:.+ \/home\/user\/\.ssh\/id_ed25519 \(ED25519\)/);
  });

  // A7
  it('A7 — `ssh-add -D` deletes all identities; subsequent -l prints "no identities"', async () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/user/.ssh/id_ed25519', 'ed', 1000, 1000, 0o077);
    await pc.executeCommand('ssh-add');
    await pc.executeCommand('ssh-add -D');
    const out = await pc.executeCommand('ssh-add -l');
    expect(out).toMatch(/The agent has no identities\./);
  });

  // A8
  it('A8 — `ssh-add -d <path>` deletes a single identity', async () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/user/.ssh/id_ed25519', 'ed', 1000, 1000, 0o077);
    vfs.writeFile('/home/user/.ssh/id_rsa', 'rsa', 1000, 1000, 0o077);
    await pc.executeCommand('ssh-add');
    await pc.executeCommand('ssh-add -d /home/user/.ssh/id_ed25519');
    const out = await pc.executeCommand('ssh-add -l');
    expect(out).toMatch(/\/home\/user\/\.ssh\/id_rsa/);
    expect(out).not.toMatch(/\/home\/user\/\.ssh\/id_ed25519/);
  });
});

function pcVfs(pc: LinuxPC): import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem {
  return (pc as unknown as {
    executor: { vfs: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem };
  }).executor.vfs;
}
