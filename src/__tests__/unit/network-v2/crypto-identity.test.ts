/**
 * Cisco IOS Security Command Reference: `crypto identity NAME` (with `dn` and `fqdn`), `set identity NAME`
 * in a crypto map entry, `show crypto identity [TAG]`. Without `set identity` a crypto map entry has no
 * restriction beyond the peer address; with it only the peers that match the identity can use the entry:
 * `dn` is compared with the distinguished name of the certificate the peer authenticated with, `fqdn`
 * with the host name the peer announced. The examples of the reference give the `show` layout:
 * "crypto identity tag12:", "Description: ...", "fqdn ...".
 *
 * Ours, not in the reference: an identity with several entries admits a peer that matches any of them, and
 * an entry that names an identity which does not exist admits nobody (a security criterion fails closed).
 *
 * Lab 1: two routers, real IKEv2 with RSA certificates issued by a CA router (the PKI lab of
 * ipsec-pki-trustpoint). Lab 2: ipsecLab with `crypto isakmp identity hostname` on the initiator.
 *
 * Measured with src stashed to HEAD: 4 of the 8 cases fall (the three refusals and the show/running-config case). Four pass
 * either way: the two witnesses and the two cases that admit the peer, since before the change nothing restricts a
 * crypto map entry; each admitting case is paired with a refusal that does fall.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { buildLab, configureBase, buildCa, enrollTrustpoint, configureX509Profile, seedPcs } from './_helpers/pkiIpsecLab';
import { ipsecLab } from './_helpers/ipsecLab';
import { run } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function certificateLab(responderLines: string[]) {
  const l = await buildLab();
  await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
  await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
  await buildCa('CA', [
    { peer: l.r1, caIp: '10.9.1.1', peerIp: '10.9.1.2', caPort: 'GigabitEthernet0/0' },
    { peer: l.r2, caIp: '10.9.2.1', peerIp: '10.9.2.2', caPort: 'GigabitEthernet0/1' },
  ]);
  await enrollTrustpoint(l.r1, 'http://10.9.1.1', 'CN=r1.lab,OU=BigBiz');
  await enrollTrustpoint(l.r2, 'http://10.9.2.1', 'CN=r2.lab');
  await configureX509Profile(l.r1, '10.0.12.2');
  await configureX509Profile(l.r2, '10.0.12.1');
  await run(l.r2, responderLines);
  await seedPcs(l.pc1, l.pc2);
  return l;
}

const restrict = (identityLines: string[], name = 'ID'): string[] => [
  `crypto identity ${name}`, ...identityLines, 'exit', 'crypto map CMAP 10 ipsec-isakmp', `set identity ${name}`, 'exit',
];

describe('crypto identity — certificate DN', () => {
  it('witness (passes either way): without set identity the tunnel comes up', async () => {
    const l = await certificateLab([]);
    expect(await pingOnSimulatedClock(l.pc1, 'ping -c 2 192.168.2.10')).toContain('2 received');
  });

  it('a dn that the peer certificate carries admits the peer', async () => {
    const l = await certificateLab(restrict(['dn ou=BigBiz']));
    expect(await pingOnSimulatedClock(l.pc1, 'ping -c 2 192.168.2.10')).toContain('2 received');
    expect(await l.r2.executeCommand('show crypto ikev2 sa')).toMatch(/READY/);
  });

  it('a dn that the certificate does not carry refuses the peer', async () => {
    const l = await certificateLab(restrict(['dn ou=Other']));
    await pingOnSimulatedClock(l.pc1, 'ping -c 1 192.168.2.10');
    expect(await l.r2.executeCommand('show crypto ikev2 sa')).not.toMatch(/READY/);
    expect(await l.r1.executeCommand('show crypto ikev2 sa')).not.toMatch(/READY/);
  });

  it('an entry that names an identity which does not exist admits nobody', async () => {
    const l = await certificateLab(['crypto map CMAP 10 ipsec-isakmp', 'set identity NOSUCH', 'exit']);
    await pingOnSimulatedClock(l.pc1, 'ping -c 1 192.168.2.10');
    expect(await l.r2.executeCommand('show crypto ikev2 sa')).not.toMatch(/READY/);
  });
});

describe('crypto identity — fqdn', () => {
  const ping = (l: Awaited<ReturnType<typeof ipsecLab>>) => clock.advanceUntilSettled(l.pc1.executeCommand('ping -c 1 192.168.2.10'));

  it('witness (passes either way): a hostname identity without set identity brings the tunnel up', async () => {
    const l = await ipsecLab();
    await run(l.r1, ['crypto isakmp identity hostname']);
    expect(await ping(l)).toContain('1 received');
  });

  it('the host name the peer announces must match the fqdn (case-insensitive)', async () => {
    const l = await ipsecLab();
    await run(l.r1, ['crypto isakmp identity hostname']);
    await run(l.r2, restrict(['fqdn r1']));
    expect(await ping(l)).toContain('1 received');
  });

  it('another fqdn refuses the peer', async () => {
    const l = await ipsecLab();
    await run(l.r1, ['crypto isakmp identity hostname']);
    await run(l.r2, restrict(['fqdn somebody.else']));
    expect(await ping(l)).toContain('0 received');
  });

  it('show crypto identity and the running-config follow the reference layout', async () => {
    const l = await ipsecLab();
    await run(l.r2, ['crypto identity tag12', 'description Linedescription', 'fqdn fullyauthorisedone', 'dn ou=BigBiz', 'exit',
      'crypto map CMAP 10 ipsec-isakmp', 'set identity tag12', 'exit']);
    await l.r2.executeCommand('enable');
    expect(await l.r2.executeCommand('show crypto identity tag12')).toBe(
      'crypto identity tag12:\nDescription: Linedescription\nfqdn fullyauthorisedone\ndn ou=BigBiz');
    expect(await l.r2.executeCommand('show crypto identity')).toContain('crypto identity tag12:');
    const config = await l.r2.executeCommand('show running-config');
    for (const line of ['crypto identity tag12', ' description Linedescription', ' fqdn fullyauthorisedone', ' dn ou=BigBiz', ' set identity tag12']) {
      expect(config).toContain(line);
    }
  });
});
