/**
 * SSH LAN — agent forwarding (`ssh -A`).
 *
 * OpenSSH `-A` lets the remote shell use the client's ssh-agent for
 * further authentication ("agent forwarding"). The simulator wires
 * this by copying the in-memory `SshAgent` from the local device's
 * executor to the remote device's executor for the duration of the
 * SSH session.
 *
 * Scope:
 *  - FA1 : parser recognises `-A`.
 *  - FA2 : `-o ForwardAgent=yes` is equivalent.
 *  - FA3 : `-A` defaults to false otherwise.
 *  - FA4 : Mirror copies the keys to the remote agent on connect.
 *  - FA5 : When ForwardAgent is false, the remote agent stays empty.
 *  - FA6 : Mirror.detach() cleans up the remote agent state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { parseSshArgs } from '@/terminal/sessions/sshArgs';
import { SshAgent } from '@/network/protocols/ssh/SshAgent';
import { SshAgentForwarding } from '@/network/protocols/ssh/SshAgentForwarding';

describe('SSH LAN — agent forwarding (`ssh -A`)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
  });

  // FA1
  it('FA1 — parseSshArgs recognises the `-A` flag', () => {
    const parsed = parseSshArgs(['-A', 'user@10.0.0.2']);
    expect(parsed!.forwardAgent).toBe(true);
  });

  // FA2
  it('FA2 — `-o ForwardAgent=yes` is equivalent to `-A`', () => {
    expect(parseSshArgs(['-o', 'ForwardAgent=yes', 'h'])!.forwardAgent).toBe(true);
    expect(parseSshArgs(['-o', 'ForwardAgent=no', 'h'])!.forwardAgent).toBe(false);
  });

  // FA3
  it('FA3 — forwardAgent defaults to false when not requested', () => {
    expect(parseSshArgs(['user@h'])!.forwardAgent).toBe(false);
  });

  // FA4
  it('FA4 — SshAgentForwarding copies every local key into the remote agent', () => {
    const local = new SshAgent();
    const remote = new SshAgent();
    // Add two simulated identities locally (no VFS needed — directly inject
    // via the in-memory facade).
    (local as unknown as { keys: Map<string, unknown> }).keys.set('/k1', {
      path: '/k1', material: 'm1', fingerprint: 'SHA256:aaa',
      algorithm: 'ED25519', comment: 'k1', bits: 256,
    });
    (local as unknown as { keys: Map<string, unknown> }).keys.set('/k2', {
      path: '/k2', material: 'm2', fingerprint: 'SHA256:bbb',
      algorithm: 'RSA', comment: 'k2', bits: 2048,
    });
    const fwd = new SshAgentForwarding(local, remote);
    fwd.attach();
    expect(remote.list().map((k) => k.path).sort()).toEqual(['/k1', '/k2']);
  });

  // FA5
  it('FA5 — without forwarding, the remote agent stays empty', () => {
    const local = new SshAgent();
    const remote = new SshAgent();
    (local as unknown as { keys: Map<string, unknown> }).keys.set('/k1', {
      path: '/k1', material: 'm1', fingerprint: 'SHA256:aaa',
      algorithm: 'ED25519', comment: 'k1', bits: 256,
    });
    // No SshAgentForwarding created → no copy.
    expect(remote.list()).toHaveLength(0);
  });

  // FA6
  it('FA6 — detach() removes only the keys this forwarding installed', () => {
    const local = new SshAgent();
    const remote = new SshAgent();
    (local as unknown as { keys: Map<string, unknown> }).keys.set('/k1', {
      path: '/k1', material: 'm1', fingerprint: 'SHA256:aaa',
      algorithm: 'ED25519', comment: 'k1', bits: 256,
    });
    // Pre-existing remote key — should survive detach.
    (remote as unknown as { keys: Map<string, unknown> }).keys.set('/pre', {
      path: '/pre', material: 'p', fingerprint: 'SHA256:ccc',
      algorithm: 'ECDSA', comment: 'pre', bits: 256,
    });
    const fwd = new SshAgentForwarding(local, remote);
    fwd.attach();
    expect(remote.list().map((k) => k.path).sort()).toEqual(['/k1', '/pre']);
    fwd.detach();
    expect(remote.list().map((k) => k.path)).toEqual(['/pre']);
  });
});
