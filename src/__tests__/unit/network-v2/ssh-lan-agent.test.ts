/**
 * SSH LAN — in-memory ssh-agent + `ssh-add`.
 *
 * Subsystems:
 *  - SshAgent: in-memory key cache, one per LinuxPC. Keys are indexed by
 *    their public key, as ssh-agent does, and remember the file they came
 *    from.
 *  - `ssh-add` command: load default identities, list, delete.
 *
 * Scope:
 *  - A1..A3 : SshAgent add/list/remove round-trips.
 *  - A4     : add() refuses what is not a private key.
 *  - A5..A8 : `ssh-add` CLI from a LinuxPC (no args, -l, -d, -D).
 *  - A9     : the key carries its own comment, size and type.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { SshAgent } from '@/network/protocols/ssh/SshAgent';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { keygenDeterministicPair } from '@/network/devices/linux/network/SshKeygenMaterial';

describe('SSH LAN — in-memory ssh-agent + ssh-add', () => {
  let pc: LinuxPC;
  let agent: SshAgent;

  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.getInstance().clear();
    pc = new LinuxPC('linux-pc', 'PC1');
    agent = new SshAgent();
  });

  // ─── SshAgent core ────────────────────────────────────────────

  // A1
  it('A1 — add() loads a private key from the VFS and indexes it by key', () => {
    const vfs = pcVfs(pc);
    writeKey(vfs, '/home/user/.ssh/id_ed25519', ED25519);
    expect(agent.add('/home/user/.ssh/id_ed25519', vfs)).toBe(true);
    expect(agent.list().map((k) => k.blob)).toEqual([ED25519.pub.split(' ')[1]]);
  });

  // A2
  it('A2 — add() refuses a non-existent file (returns false, list unchanged)', () => {
    const vfs = pcVfs(pc);
    expect(agent.add('/home/user/.ssh/missing', vfs)).toBe(false);
    expect(agent.list()).toHaveLength(0);
  });

  // A3
  it('A3 — removeKey() drops a single key, removeAll() empties the cache', () => {
    const vfs = pcVfs(pc);
    writeKey(vfs, '/home/user/.ssh/id_ed25519', ED25519);
    writeKey(vfs, '/home/user/.ssh/id_rsa', RSA);
    agent.add('/home/user/.ssh/id_ed25519', vfs);
    agent.add('/home/user/.ssh/id_rsa', vfs);
    expect(agent.removeKey(ED25519.pub.split(' ')[1])).toBe(true);
    expect(agent.list().map((k) => k.path)).toEqual(['/home/user/.ssh/id_rsa']);
    agent.removeAll();
    expect(agent.list()).toHaveLength(0);
  });

  // A4
  it('A4 — add() refuses a file that is not a private key', () => {
    const vfs = pcVfs(pc);
    vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/user/.ssh/id_ed25519', 'material', 1000, 1000, 0o077);
    expect(agent.load('/home/user/.ssh/id_ed25519', vfs).status).toBe('invalid');
    expect(agent.list()).toHaveLength(0);
  });

  // A9
  it('A9 — the key carries its comment, its size and its type', () => {
    const vfs = pcVfs(pc);
    writeKey(vfs, '/home/user/.ssh/id_ed25519', ED25519);
    agent.add('/home/user/.ssh/id_ed25519', vfs);
    const [k] = agent.list();
    expect([k.comment, k.bits, k.algorithm]).toEqual(['user@PC1', 256, 'ED25519']);
  });

  // ─── `ssh-add` command ────────────────────────────────────────

  // A5
  it('A5 — `ssh-add` with no args loads the user\'s default identities', async () => {
    writeKey(pcVfs(pc), '/home/user/.ssh/id_ed25519', ED25519);
    const out = await pc.executeCommand('ssh-add');
    expect(out).toBe('Identity added: /home/user/.ssh/id_ed25519 (user@PC1)');
  });

  // A6
  it('A6 — `ssh-add -l` lists the loaded fingerprints', async () => {
    writeKey(pcVfs(pc), '/home/user/.ssh/id_ed25519', ED25519);
    await pc.executeCommand('ssh-add');
    const out = await pc.executeCommand('ssh-add -l');
    expect(out).toMatch(/^256 SHA256:\S+ user@PC1 \(ED25519\)$/);
  });

  // A7
  it('A7 — `ssh-add -D` deletes all identities; subsequent -l prints "no identities"', async () => {
    writeKey(pcVfs(pc), '/home/user/.ssh/id_ed25519', ED25519);
    await pc.executeCommand('ssh-add');
    await pc.executeCommand('ssh-add -D');
    const out = await pc.executeCommand('ssh-add -l');
    expect(out).toMatch(/The agent has no identities\./);
  });

  // A8
  it('A8 — `ssh-add -d <path>` deletes a single identity', async () => {
    const vfs = pcVfs(pc);
    writeKey(vfs, '/home/user/.ssh/id_ed25519', ED25519);
    writeKey(vfs, '/home/user/.ssh/id_rsa', RSA);
    await pc.executeCommand('ssh-add');
    await pc.executeCommand('ssh-add -d /home/user/.ssh/id_ed25519');
    const out = await pc.executeCommand('ssh-add -l');
    expect(out).toMatch(/rsa@PC1 \(RSA\)/);
    expect(out).not.toMatch(/\(ED25519\)/);
  });
});

const ED25519 = keygenDeterministicPair('ssh-ed25519', 'agent-a', 'user@PC1');
const RSA = keygenDeterministicPair('ssh-rsa', 'agent-b', 'rsa@PC1');

function writeKey(vfs: VirtualFileSystem, path: string, pair: { priv: string; pub: string }): void {
  vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
  vfs.writeFile(path, pair.priv, 1000, 1000, 0o077);
  vfs.writeFile(`${path}.pub`, `${pair.pub}\n`, 1000, 1000, 0o022);
}

function pcVfs(pc: LinuxPC): VirtualFileSystem {
  return (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}
