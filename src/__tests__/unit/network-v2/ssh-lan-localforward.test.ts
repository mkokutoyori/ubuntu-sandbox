/**
 * SSH LAN — local port forwarding (`ssh -L`).
 *
 * OpenSSH `-L localPort:remoteHost:remotePort user@sshHost` opens a
 * listener on `localPort` that tunnels every accepted connection
 * through the SSH session to `remoteHost:remotePort` (resolved by the
 * SSH server).
 *
 * Scope (parser + scaffolding — the wire-level bridging is verified
 * via the listener registration on the local device):
 *  - L1..L3 : parseLocalForwardSpec accepts 3-part / 4-part / rejects bad.
 *  - L4..L5 : parseSshArgs collects multiple `-L` and `-o LocalForward=`.
 *  - L6     : SshLocalForwarder.register() leaves a listener on the local
 *             device and is observable via getActiveLocalForwards().
 *  - L7     : dispose() releases the registration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import {
  parseLocalForwardSpec,
  parseSshArgs,
} from '@/terminal/sessions/sshArgs';
import { SshLocalForwarder } from '@/network/protocols/ssh/SshLocalForwarder';
import {
  buildLan,
  assignIps,
  type SshLan,
  PC2_IP,
} from './ssh-lan-fixtures';

describe('SSH LAN — local port forwarding (`ssh -L`)', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
  });

  // ─── parser ───────────────────────────────────────────────────

  // L1
  it('L1 — parseLocalForwardSpec accepts the 3-part form', () => {
    expect(parseLocalForwardSpec('8080:example.com:80')).toEqual({
      localPort: 8080,
      remoteHost: 'example.com',
      remotePort: 80,
    });
  });

  // L2
  it('L2 — parseLocalForwardSpec accepts the 4-part form (bindAddress ignored)', () => {
    expect(parseLocalForwardSpec('127.0.0.1:8080:example.com:80')).toEqual({
      localPort: 8080,
      remoteHost: 'example.com',
      remotePort: 80,
    });
  });

  // L3
  it('L3 — parseLocalForwardSpec returns null on malformed input', () => {
    expect(parseLocalForwardSpec('not-a-spec')).toBeNull();
    expect(parseLocalForwardSpec('abc:def:ghi')).toBeNull();
    expect(parseLocalForwardSpec('0:host:80')).toBeNull();
    expect(parseLocalForwardSpec('80::443')).toBeNull();
  });

  // L4
  it('L4 — parseSshArgs collects multiple `-L` entries', () => {
    const parsed = parseSshArgs([
      '-L', '8080:web.example.com:80',
      '-L', '5432:db.example.com:5432',
      'user@10.0.0.2',
    ]);
    expect(parsed!.localForwards).toHaveLength(2);
    expect(parsed!.localForwards[0].localPort).toBe(8080);
    expect(parsed!.localForwards[1].localPort).toBe(5432);
  });

  // L5
  it('L5 — `-o LocalForward=...` adds to the same list', () => {
    const parsed = parseSshArgs([
      '-o', 'LocalForward=9000:api.example.com:443',
      'user@10.0.0.2',
    ]);
    expect(parsed!.localForwards).toEqual([
      { localPort: 9000, remoteHost: 'api.example.com', remotePort: 443 },
    ]);
  });

  // ─── activation ───────────────────────────────────────────────

  // L6
  it('L6 — SshLocalForwarder.register() leaves a TCP listener on the local device', () => {
    const fwd = new SshLocalForwarder(lan.pc1, /* session */ null, {
      localPort: 8080,
      remoteHost: 'web',
      remotePort: 80,
      sshHost: PC2_IP,
    });
    fwd.register();
    expect(isPortListening(lan.pc1, 8080)).toBe(true);
    expect(fwd.getSpec().localPort).toBe(8080);
  });

  // L7
  it('L7 — dispose() unregisters the listener and clears the spec', () => {
    const fwd = new SshLocalForwarder(lan.pc1, null, {
      localPort: 8080,
      remoteHost: 'web',
      remotePort: 80,
      sshHost: PC2_IP,
    });
    fwd.register();
    expect(isPortListening(lan.pc1, 8080)).toBe(true);
    fwd.dispose();
    expect(isPortListening(lan.pc1, 8080)).toBe(false);
  });
});

function isPortListening(device: unknown, port: number): boolean {
  const stack = (device as { getTcpStack?: () => { listListeners: () => Array<{ localPort: number }> } }).getTcpStack?.();
  if (!stack) return false;
  return stack.listListeners().some(l => l.localPort === port);
}
