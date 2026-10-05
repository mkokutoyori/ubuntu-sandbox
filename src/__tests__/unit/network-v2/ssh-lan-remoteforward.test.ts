/**
 * SSH LAN — remote port forwarding (`ssh -R`).
 *
 * OpenSSH `-R remotePort:localHost:localPort user@sshHost` opens a
 * listener on the SSH **server** at `remotePort`; every accepted
 * connection is tunneled back through the SSH session and bridged to
 * `localHost:localPort` (resolved by the client).
 *
 * This is the mirror of `-L`: a `tcpip-forward` global request on the
 * SSH connection, answered by the server, which then listens and opens
 * a `forwarded-tcpip` channel per accepted connection (RFC 4254 §7.1).
 *
 * Scope:
 *  - R1..R3 : parseRemoteForwardSpec accepts 3-part / 4-part / rejects bad.
 *  - R4..R5 : parseSshArgs collects multiple `-R` and `-o RemoteForward=`.
 *  - R6     : SshRemoteForwarder.register() leaves a listener on the
 *             REMOTE device, requested over the wire.
 *  - R7     : dispose() cancels it (cancel-tcpip-forward).
 *  - R8     : ending the session releases it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import {
  parseRemoteForwardSpec,
  parseSshArgs,
} from '@/terminal/sessions/sshArgs';
import { SshRemoteForwarder } from '@/network/protocols/ssh/SshRemoteForwarder';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  buildLan,
  assignIps,
  type SshLan,
  PC2_IP,
  openSshSession,
} from './ssh-lan-fixtures';

describe('SSH LAN — remote port forwarding (`ssh -R`)', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.getInstance().clear();
    lan = buildLan();
    await assignIps(lan);
  });

  // ─── parser ───────────────────────────────────────────────────

  // R1
  it('R1 — parseRemoteForwardSpec accepts the 3-part form', () => {
    expect(parseRemoteForwardSpec('8080:localhost:80')).toEqual({
      remotePort: 8080,
      localHost: 'localhost',
      localPort: 80,
    });
  });

  // R2
  it('R2 — parseRemoteForwardSpec accepts the 4-part form (bindAddress ignored)', () => {
    expect(parseRemoteForwardSpec('0.0.0.0:8080:localhost:80')).toEqual({
      remotePort: 8080,
      localHost: 'localhost',
      localPort: 80,
    });
  });

  // R3
  it('R3 — parseRemoteForwardSpec returns null on malformed input', () => {
    expect(parseRemoteForwardSpec('not-a-spec')).toBeNull();
    expect(parseRemoteForwardSpec('abc:def:ghi')).toBeNull();
    expect(parseRemoteForwardSpec('0:host:80')).toBeNull();
    expect(parseRemoteForwardSpec('80::443')).toBeNull();
  });

  // R4
  it('R4 — parseSshArgs collects multiple `-R` entries', () => {
    const parsed = parseSshArgs([
      '-R', '8080:localhost:80',
      '-R', '9090:localhost:9000',
      'user@10.0.0.2',
    ]);
    expect(parsed!.remoteForwards).toHaveLength(2);
    expect(parsed!.remoteForwards[0].remotePort).toBe(8080);
    expect(parsed!.remoteForwards[1].remotePort).toBe(9090);
  });

  // R5
  it('R5 — `-o RemoteForward=...` adds to the same list', () => {
    const parsed = parseSshArgs([
      '-o', 'RemoteForward=9000:localhost:443',
      'user@10.0.0.2',
    ]);
    expect(parsed!.remoteForwards).toEqual([
      { remotePort: 9000, localHost: 'localhost', localPort: 443 },
    ]);
  });

  // ─── activation ───────────────────────────────────────────────

  // R6
  it('R6 — SshRemoteForwarder.register() asks the server over the wire for a listener on the REMOTE device', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const fwd = new SshRemoteForwarder(session, lan.pc1, {
      remotePort: 8080,
      localHost: 'localhost',
      localPort: 80,
      sshHost: PC2_IP,
    });
    expect(await fwd.register()).toBe(true);
    expect(isPortListening(lan.pc2, 8080)).toBe(true);
    expect(isPortListening(lan.pc1, 8080)).toBe(false);
    session.disconnect();
  });

  // R7
  it('R7 — dispose() cancels the forward and the server releases the listener', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const fwd = new SshRemoteForwarder(session, lan.pc1, {
      remotePort: 8080,
      localHost: 'localhost',
      localPort: 80,
      sshHost: PC2_IP,
    });
    await fwd.register();
    expect(isPortListening(lan.pc2, 8080)).toBe(true);
    fwd.dispose();
    await Promise.resolve();
    expect(isPortListening(lan.pc2, 8080)).toBe(false);
    session.disconnect();
  });

  it('R8 — a session that ends takes its remote listeners with it', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const fwd = new SshRemoteForwarder(session, lan.pc1, {
      remotePort: 8081,
      localHost: 'localhost',
      localPort: 80,
      sshHost: PC2_IP,
    });
    await fwd.register();
    expect(isPortListening(lan.pc2, 8081)).toBe(true);
    session.disconnect();
    expect(isPortListening(lan.pc2, 8081)).toBe(false);
  });
});

function isPortListening(device: unknown, port: number): boolean {
  const stack = (device as { getTcpStack?: () => { listListeners: () => Array<{ localPort: number }> } }).getTcpStack?.();
  if (!stack) return false;
  return stack.listListeners().some(l => l.localPort === port);
}
