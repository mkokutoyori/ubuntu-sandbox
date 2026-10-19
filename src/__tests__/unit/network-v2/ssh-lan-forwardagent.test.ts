/**
 * SSH LAN — agent forwarding (`ssh -A`).
 *
 * OpenSSH `-A` lets the remote shell use the client's ssh-agent for
 * further authentication ("agent forwarding"). The simulator wires
 * this over an `auth-agent@openssh.com` channel (see
 * probe-agent-forwarding-sur-le-fil.test.ts for the protocol cases).
 *
 * Scope:
 *  - FA1 : parser recognises `-A`.
 *  - FA2 : `-o ForwardAgent=yes` is equivalent.
 *  - FA3 : `-A` defaults to false otherwise.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { parseSshArgs } from '@/terminal/sessions/sshArgs';
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
});
