/**
 * Cisco IOS Security Command Reference: `crypto pki crl request NAME` ("request that a new CRL be obtained
 * immediately from the CA"; a CRL is reused until it expires), `show crypto pki crls`, `clear crypto pki
 * crls`, and `revocation-check crl`. A certificate that appears in the CRL is not accepted and the peer is
 * not authenticated, so a router whose certificate was revoked cannot exchange IPsec traffic with a router
 * holding the new list.
 *
 * Lab: the PKI lab of ipsec-pki-trustpoint (R1 - R2, a CA router with the IOS certificate server, IKEv2 with
 * RSA certificates). The CRL travels over HTTP from the certificate server; the revocation is made with
 * `crypto pki server CS revoke`.
 *
 * Ours, not in the reference: the CRL is fetched at enrollment and again when its NextUpdate has passed
 * (IOS fetches it lazily at the first validation), and the CDP line of `show crypto pki crls` repeats the
 * reference example ("CDP Not Published - Retrieved via SCEP").
 *
 * Measured with src stashed to HEAD: every case but the two witnesses falls (no crl request, no CRL, `crl`
 * checked nothing). Witnesses: with `revocation-check none` a revoked certificate still gets its tunnel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';
import { buildLab, configureBase, buildCa, enrollTrustpoint, configureX509Profile, seedPcs } from './_helpers/pkiIpsecLab';
import { run } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function crlLab(revocation: string) {
  const l = await buildLab();
  await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
  await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
  const ca = await buildCa('CA', [
    { peer: l.r1, caIp: '10.9.1.1', peerIp: '10.9.1.2', caPort: 'GigabitEthernet0/0' },
    { peer: l.r2, caIp: '10.9.2.1', peerIp: '10.9.2.2', caPort: 'GigabitEthernet0/1' },
  ]);
  await run(ca, ['crypto pki server CS', 'lifetime crl 1']);
  await clock.advanceUntilSettled(enrollTrustpoint(l.r1, 'http://10.9.1.1', 'CN=r1.lab', revocation));
  await clock.advanceUntilSettled(enrollTrustpoint(l.r2, 'http://10.9.2.1', 'CN=r2.lab', revocation));
  await configureX509Profile(l.r1, '10.0.12.2');
  await configureX509Profile(l.r2, '10.0.12.1');
  await seedPcs(l.pc1, l.pc2);
  return { ...l, ca };
}

const ping = (l: Awaited<ReturnType<typeof crlLab>>) => clock.advanceUntilSettled(l.pc1.executeCommand('ping -c 2 192.168.2.10'));
const serialOf = (router: Awaited<ReturnType<typeof crlLab>>['r1']): string =>
  getSecurityConfig(router).pkiTrustpoints.get('TP')!.localCert!.serialNumber;

async function resetTunnel(l: Awaited<ReturnType<typeof crlLab>>): Promise<void> {
  for (const router of [l.r1, l.r2]) {
    await run(router, []);
    await router.executeCommand('clear crypto sa');
    await router.executeCommand('clear crypto ikev2 sa');
    await router.executeCommand('clear crypto isakmp');
  }
}

describe('certificate revocation lists', () => {
  it('enrollment fetches the CRL of the CA and show crypto pki crls prints it in the reference layout', async () => {
    const l = await crlLab('crl');
    await l.r1.executeCommand('enable');
    const shown = await l.r1.executeCommand('show crypto pki crls');
    expect(shown).toContain('CRL Issuer Name:');
    expect(shown).toMatch(/\n\s+CN=CA-CA/i);
    expect(shown).toMatch(/LastUpdate: \d\d:\d\d:\d\d GMT \w{3} \d+ \d{4}/);
    expect(shown).toMatch(/NextUpdate: \d\d:\d\d:\d\d GMT \w{3} \d+ \d{4}/);
    expect(shown).toContain('Retrieved from CRL Distribution Point:');
    expect(await ping(l)).toContain('2 received');
  });

  it('witness (passes either way): with revocation-check none a revoked certificate still gets its tunnel', async () => {
    const l = await crlLab('none');
    await l.ca.executeCommand('enable');
    await l.ca.executeCommand(`crypto pki server CS revoke ${serialOf(l.r1)}`);
    expect(await ping(l)).toContain('2 received');
  });

  it('a revocation is not known until the CRL is requested again; then the peer is refused', async () => {
    const l = await crlLab('crl');
    await l.ca.executeCommand('enable');
    expect(await l.ca.executeCommand(`crypto pki server CS revoke ${serialOf(l.r1)}`)).toBe('');
    await resetTunnel(l);
    expect(await ping(l)).toContain('2 received');
    await resetTunnel(l);
    await run(l.r2, ['crypto pki crl request TP']);
    await ping(l);
    expect(await l.r2.executeCommand('show crypto ikev2 sa')).not.toMatch(/READY/);
    expect(getSecurityConfig(l.r2).pkiTrustpoints.get('TP')!.crl!.contains(serialOf(l.r1))).toBe(true);
  });

  it('clear crypto pki crls empties the database and a strict check then refuses the peer', async () => {
    const l = await crlLab('crl');
    await l.r2.executeCommand('enable');
    await l.r2.executeCommand('clear crypto pki crls');
    expect(await l.r2.executeCommand('show crypto pki crls')).toBe('');
    await resetTunnel(l);
    await ping(l);
    expect(await l.r2.executeCommand('show crypto ikev2 sa')).not.toMatch(/READY/);
    await run(l.r2, ['crypto pki crl request TP']);
    await resetTunnel(l);
    expect(await ping(l)).toContain('2 received');
  });

  it('the CRL is requested again when it has expired', async () => {
    const l = await crlLab('crl');
    const first = getSecurityConfig(l.r1).pkiTrustpoints.get('TP')!.crl!;
    await clock.advance(3_700_000);
    await clock.advanceUntilSettled(new Promise<void>((resolve) => setTimeout(resolve, 50)));
    const second = getSecurityConfig(l.r1).pkiTrustpoints.get('TP')!.crl!;
    expect(second.thisUpdate).toBeGreaterThan(first.thisUpdate);
  });

  it('a trustpoint that is not authenticated, or has no enrollment url, cannot request a CRL', async () => {
    const l = await buildLab();
    const out = await run(l.r1, ['crypto pki trustpoint TP', 'exit', 'crypto pki crl request TP']);
    expect(out.join('\n')).toMatch(/not authenticated/);
    expect(await l.r1.executeCommand('show crypto pki crls')).toBe('');
  });

  it('`crypto ca crl request` is the same command', async () => {
    const l = await crlLab('crl');
    const out = await clock.advanceUntilSettled(run(l.r1, ['crypto ca crl request TP']));
    expect(out.join('\n')).not.toContain('Invalid input');
  });
});
