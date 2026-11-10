/*
 * Probe: FortiOS 7.4.12 (vpn ipsec phase1-interface, p.2113) documents `ppk [disable|allow|require]`, `ppk-identity` and
 * `ppk-secret` (ASCII or 0x hex): the IKEv2 post-quantum preshared key of RFC 8784. The words did not exist. The identity now
 * travels in the offer and the answer says whether the key was used; when both ends hold the same identity the secret is mixed
 * into the key derivation, so the child SA keys are no longer a function of the classical exchange alone. `require` fails the
 * negotiation (AUTHENTICATION_FAILED) when the other end does not take part, `allow` falls back to the classical keys, two ends
 * holding the same identity with different secrets derive different keys, and PPK is refused outside IKEv2 or without both words.
 * The engine runs one negotiation path whatever ike-version says; the CLI limit to IKEv2 is the standard's.
 *
 * Two FortiGate face each other on port2 with a PSK tunnel and one phase 2.
 * Discriminated with git stash on src/network: 3 of 7 fall before the change (require against nothing, different secrets, the
 * CLI refusals). Four pass either way: the no-PPK witness, `allow` against nothing (falls back, comes up), and the two cases of
 * agreement, which only prove the lab still negotiates once the words are accepted (before the change the CLI refused them and
 * the tunnel came up classically). The SPIs are random, so the keys of two tunnels are never comparable: only the two ends of
 * one tunnel are.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  const all: string[] = [];
  for (const line of lines) { last = sh.execute(line); all.push(last); }
  return all.join('\n') || last;
}

function site(name: string, lan: string, wan: string, peer: string, remoteLan: string, ppk: readonly string[]) {
  const fw = new FortiGate('firewall-fortinet', name, 0, 0);
  const sh = new FortiShell(fw);
  run(sh, 'config system interface', 'edit "port1"', 'set mode static', `set ip ${lan}.1 255.255.255.0`, 'next',
    'edit "port2"', 'set mode static', `set ip ${wan} 255.255.255.0`, 'set allowaccess ping', 'next', 'end');
  const replies = run(sh, 'config vpn ipsec phase1-interface', 'edit "t"', 'set interface "port2"', 'set ike-version 2', `set remote-gw ${peer}`,
    'set psksecret "SecretPartage2026"', 'set proposal aes256-sha256', 'set dhgrp 14', ...ppk, 'next', 'end',
    'config vpn ipsec phase2-interface', 'edit "t-p2"', 'set phase1name "t"',
    `set src-subnet ${lan}.0 255.255.255.0`, `set dst-subnet ${remoteLan}.0 255.255.255.0`, 'next', 'end');
  return { fw, sh, replies };
}

function lab(aPpk: readonly string[], bPpk: readonly string[]) {
  const a = site('A', '192.168.1', '203.0.113.1', '203.0.113.2', '192.168.2', aPpk);
  const b = site('B', '192.168.2', '203.0.113.2', '203.0.113.1', '192.168.1', bPpk);
  new Cable('ab').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);
  a.fw.bringUpIpsecTunnel('t');
  return { a, b };
}

const up = (s: { fw: FortiGate }, peer: string): boolean => s.fw.getIpsecEngine().getIPSecSAs(peer).length > 0;
const espKey = (s: { fw: FortiGate }, peer: string): string | undefined =>
  (s.fw.getIpsecEngine().getIPSecSAs(peer)[0] as unknown as { cryptoKeys?: { espEncKey: string } } | undefined)?.cryptoKeys?.espEncKey;
const ppk = (mode: string, secret = 'QuantumSecret01') => [`set ppk ${mode}`, 'set ppk-identity "ppk-1"', `set ppk-secret "${secret}"`];

describe('ipsec ppk (RFC 8784)', () => {
  it('witness: without PPK the tunnel comes up', () => {
    const { a } = lab([], []);
    expect(up(a, '203.0.113.2')).toBe(true);
  });

  it('require on both ends with the same identity and secret comes up', () => {
    const { a, b } = lab(ppk('require'), ppk('require'));
    expect(up(a, '203.0.113.2')).toBe(true);
    expect(up(b, '203.0.113.1')).toBe(true);
  });

  it('both ends of a PPK tunnel derive the same child SA key', () => {
    const { a, b } = lab(ppk('require'), ppk('require'));
    expect(espKey(a, '203.0.113.2')).toBeDefined();
    expect(espKey(a, '203.0.113.2')).toBe(espKey(b, '203.0.113.1'));
  });

  it('require against an end without PPK fails the negotiation', () => {
    const { a } = lab(ppk('require'), []);
    expect(up(a, '203.0.113.2')).toBe(false);
  });

  it('allow against an end without PPK falls back to the classical keys', () => {
    const { a } = lab(ppk('allow'), []);
    expect(up(a, '203.0.113.2')).toBe(true);
  });

  it('the same identity with different secrets derives different keys', () => {
    const { a, b } = lab(ppk('require', 'QuantumSecret01'), ppk('require', 'QuantumSecret02'));
    expect(espKey(a, '203.0.113.2')).not.toBe(espKey(b, '203.0.113.1'));
  });

  it('ppk is refused without IKEv2 or without identity and secret', () => {
    const fw = new FortiGate('firewall-fortinet', 'F', 0, 0);
    const sh = new FortiShell(fw);
    const v1 = run(sh, 'config vpn ipsec phase1-interface', 'edit "x"', 'set interface "port2"', 'set ike-version 1', 'set ppk allow', 'next', 'end');
    expect(v1).toMatch(/IKEv2 extension \(RFC 8784\)/);
    const none = run(sh, 'config vpn ipsec phase1-interface', 'edit "y"', 'set interface "port2"', 'set ike-version 2', 'set ppk require', 'next', 'end');
    expect(none).toMatch(/needs both ppk-identity and ppk-secret/);
  });
});
