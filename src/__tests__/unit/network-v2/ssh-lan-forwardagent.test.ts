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
import { SshAgent, agentKeyOf, type AgentKey } from '@/network/protocols/ssh/SshAgent';
import { keygenDeterministicPair } from '@/network/devices/linux/network/SshKeygenMaterial';
import { SshAgentForwarding } from '@/network/protocols/ssh/SshAgentForwarding';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('SSH LAN — agent forwarding (`ssh -A`)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.getInstance().clear();
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
    local.install(K1);
    local.install(K2);
    const fwd = new SshAgentForwarding(local, remote);
    fwd.attach();
    expect(remote.list().map((k) => k.comment).sort()).toEqual(['k1', 'k2']);
  });

  // FA5
  it('FA5 — without forwarding, the remote agent stays empty', () => {
    const local = new SshAgent();
    const remote = new SshAgent();
    local.install(K1);
    expect(remote.list()).toHaveLength(0);
  });

  // FA6
  it('FA6 — detach() removes only the keys this forwarding installed', () => {
    const local = new SshAgent();
    const remote = new SshAgent();
    local.install(K1);
    remote.install(PRE);
    const fwd = new SshAgentForwarding(local, remote);
    fwd.attach();
    expect(remote.list().map((k) => k.comment).sort()).toEqual(['k1', 'pre']);
    fwd.detach();
    expect(remote.list().map((k) => k.comment)).toEqual(['pre']);
  });
});

function agentKey(path: string, seed: string, comment: string): AgentKey {
  const key = agentKeyOf(path, keygenDeterministicPair('ssh-ed25519', seed, comment).priv);
  if (key === null) throw new Error('unreadable key');
  return key;
}

const K1 = agentKey('/k1', 'fwd-1', 'k1');
const K2 = agentKey('/k2', 'fwd-2', 'k2');
const PRE = agentKey('/pre', 'fwd-3', 'pre');
