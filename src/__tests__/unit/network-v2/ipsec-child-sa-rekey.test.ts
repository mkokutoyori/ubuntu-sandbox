/**
 * IKE (Phase 1) rekey never touched the Child (IPsec/ESP) SA at all —
 * rekeyIKESA/rekeyIKEv2SA only replaced the parent IKE SA's own SPI and
 * timestamp, despite the doc-comment claiming "migrate Child SAs". A real
 * IKE rekey must also rotate the child SA's SPIs and derive fresh keying
 * material. Separately, the negotiated PFS group was compared for a
 * mismatch but never actually fed into key derivation — 'set pfs group14'
 * vs no PFS at all produced byte-identical KEYMAT given the same SPIs/PSK.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { IKE_SA, IPSec_SA } from '@/network/ipsec/IPSecTypes';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function buildTunnel(pfsGroup?: string) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const wan = new Cable('wan');
  wan.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

  for (const [router, outside, peer] of [
    [r1, '10.0.12.1', '10.0.12.2'],
    [r2, '10.0.12.2', '10.0.12.1'],
  ] as [CiscoRouter, string, string][]) {
    await run(router, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/1', `ip address ${outside} 255.255.255.252`, 'no shutdown', 'exit',
      'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256',
      'authentication pre-share', 'group 14', 'lifetime 86400', 'exit',
      `crypto isakmp key ChildRekey1 address ${peer}`,
      'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
      'ip access-list extended VPN_ACL', `permit ip host ${outside} host ${peer}`, 'exit',
      'crypto map CMAP 10 ipsec-isakmp', `set peer ${peer}`,
      'set transform-set TSET', 'match address VPN_ACL',
      ...(pfsGroup ? [`set pfs ${pfsGroup}`] : []),
      'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]);
  }

  await r1.executeCommand('ping 10.0.12.2');
  return { r1, r2, wan };
}

function engineOf(router: CiscoRouter) {
  return (router as unknown as { _getIPSecEngineInternal(): {
    ikeSADB: Map<string, IKE_SA>;
    ipsecSADB: Map<string, IPSec_SA[]>;
    recheckIKESALifetimes(): void;
  } })._getIPSecEngineInternal();
}

function childSa(router: CiscoRouter, peerIp: string): IPSec_SA {
  return engineOf(router).ipsecSADB.get(peerIp)![0];
}

describe('IKE rekey rotates the Child (IPsec) SA', () => {
  it('after the IKE SA lifetime expires, the child SA gets fresh SPIs and fresh keys, not just the parent SPI', async () => {
    const { r1 } = await buildTunnel();
    const engine = engineOf(r1);
    const ikeSA = engine.ikeSADB.get('10.0.12.2')!;
    const before = childSa(r1, '10.0.12.2');
    const beforeSpiIn = before.spiIn;
    const beforeSpiOut = before.spiOut;
    const beforeEncKey = before.cryptoKeys.espEncKey;
    const beforeAuthKey = before.cryptoKeys.espAuthKey;

    ikeSA.lifetime = 60;
    ikeSA.created = Date.now() - 61_000;
    engine.recheckIKESALifetimes();

    const after = childSa(r1, '10.0.12.2');
    expect(after.spiIn).not.toBe(beforeSpiIn);
    expect(after.spiOut).not.toBe(beforeSpiOut);
    expect(after.cryptoKeys.espEncKey).not.toBe(beforeEncKey);
    expect(after.cryptoKeys.espAuthKey).not.toBe(beforeAuthKey);
  });

  it('the child SA rekey happens for IKEv2 SAs too', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    for (const [router, outside, peer] of [
      [r1, '10.0.12.1', '10.0.12.2'],
      [r2, '10.0.12.2', '10.0.12.1'],
    ] as [CiscoRouter, string, string][]) {
      await run(router, [
        'enable', 'configure terminal',
        'interface GigabitEthernet0/1', `ip address ${outside} 255.255.255.252`, 'no shutdown', 'exit',
        'crypto ikev2 proposal PROP', 'encryption aes-cbc-256', 'integrity sha256', 'group 14', 'exit',
        'crypto ikev2 policy POL', 'proposal PROP', 'exit',
        'crypto ikev2 keyring KR', 'peer P', `address ${peer}`, 'pre-shared-key ChildRekeyV2', 'exit', 'exit',
        'crypto ikev2 profile PROF',
        `match identity remote address ${peer} 255.255.255.255`,
        'authentication remote pre-share', 'authentication local pre-share', 'keyring local KR', 'exit',
        'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
        'ip access-list extended VPN_ACL', `permit ip host ${outside} host ${peer}`, 'exit',
        'crypto map CMAP 10 ipsec-isakmp', `set peer ${peer}`, 'set ikev2-profile PROF',
        'set transform-set TSET', 'match address VPN_ACL', 'exit',
        'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
      ]);
    }
    await r1.executeCommand('ping 10.0.12.2');

    const engine = (r1 as unknown as { _getIPSecEngineInternal(): {
      ikev2SADB: Map<string, { lifetime: number; created: number }>;
      ipsecSADB: Map<string, IPSec_SA[]>;
      recheckIKESALifetimes(): void;
    } })._getIPSecEngineInternal();
    const ikev2SA = engine.ikev2SADB.get('10.0.12.2')!;
    const beforeSpiIn = engine.ipsecSADB.get('10.0.12.2')![0].spiIn;

    ikev2SA.lifetime = 60;
    ikev2SA.created = Date.now() - 61_000;
    engine.recheckIKESALifetimes();

    expect(engine.ipsecSADB.get('10.0.12.2')![0].spiIn).not.toBe(beforeSpiIn);
  });
});

describe('PFS group genuinely differentiates child-SA keymat at rekey (not cosmetic)', () => {
  // The tunnel is established normally (real, unmocked randomness); only the
  // Math.random is pinned to a fixed, repeating sequence across the ENTIRE
  // run (initial negotiation AND rekey), identically for every call to this
  // helper — so every SPI generated anywhere in the process is the same
  // across the with-PFS and without-PFS scenarios below. That isolates
  // pfsGroup as the only variable that can change the derived key.
  async function rekeyAndGetEncKey(pfsGroup?: string): Promise<string> {
    let n = 0;
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      n += 1;
      return (n % 991) / 991;
    });
    try {
      const { r1 } = await buildTunnel(pfsGroup);
      const engine = engineOf(r1);
      const ikeSA = engine.ikeSADB.get('10.0.12.2')!;
      ikeSA.lifetime = 60;
      ikeSA.created = Date.now() - 61_000;
      engine.recheckIKESALifetimes();
      return childSa(r1, '10.0.12.2').cryptoKeys.espEncKey;
    } finally {
      spy.mockRestore();
    }
  }

  it('rekeying with PFS group14 yields different key material than rekeying with no PFS at all', async () => {
    const withoutPfs = await rekeyAndGetEncKey(undefined);
    const withPfs14 = await rekeyAndGetEncKey('group14');
    expect(withPfs14).not.toBe(withoutPfs);
  });

  it('different PFS groups (group14 vs group2) yield different key material from each other', async () => {
    const group14 = await rekeyAndGetEncKey('group14');
    const group2 = await rekeyAndGetEncKey('group2');
    expect(group14).not.toBe(group2);
  });
});
