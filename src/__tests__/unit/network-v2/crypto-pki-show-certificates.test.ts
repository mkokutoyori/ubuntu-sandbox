/**
 * Cisco IOS Security Command Reference: `show crypto pki certificates [trustpoint-name [verbose]]` and
 * `show crypto pki certificates pem [trustpoint-name]` (alias `show crypto ca certificates`). The listing
 * reads the certificates the trustpoints really hold: the router certificate and the CA certificate with their
 * serial numbers, and in the verbose form issuer, subject, validity, fingerprints computed from the DER
 * encoding and the associated trustpoint. The PEM form prints the very certificates, parseable back.
 *
 * Lab: R1 enrolled at the IOS certificate server of a CA router (pkiIpsecLab).
 *
 * Ours, not in the reference: the verbose layout keeps the reference field names but not its exact indentation
 * (the documentation HTML collapses whitespace), and the fingerprints are those of this simulator's DER.
 *
 * Measured with src stashed to HEAD: all five cases fall (the file imports the new display module, and the old
 * listing printed no fingerprint, a fixed "Validity: 365 days" and never named an unknown trustpoint). The
 * unknown-trustpoint case is a non-regression of the refusal, labelled as such.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';
import { pemToCert } from '@/network/pki/pem';
import { certificateFingerprints } from '@/network/devices/router/pki/CertificateDisplay';
import { buildLab, buildCa, enrollTrustpoint } from './_helpers/pkiIpsecLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function lab() {
  const l = await buildLab();
  await buildCa('CA', [{ peer: l.r1, caIp: '10.9.1.1', peerIp: '10.9.1.2', caPort: 'GigabitEthernet0/0' }]);
  await clock.advanceUntilSettled(enrollTrustpoint(l.r1, 'http://10.9.1.1', 'CN=r1.lab'));
  await l.r1.executeCommand('enable');
  return l;
}

describe('show crypto pki certificates', () => {
  it('lists the router certificate and the CA certificate with their real serial numbers', async () => {
    const l = await lab();
    const trustpoint = getSecurityConfig(l.r1).pkiTrustpoints.get('TP')!;
    const out = await l.r1.executeCommand('show crypto pki certificates');
    expect(out).toMatch(/^Certificate\n {2}Status: Available/);
    expect(out).toContain(`Certificate Serial Number: ${trustpoint.localCert!.serialNumber}`);
    expect(out).toContain('CA Certificate');
    expect(out).toContain(`Certificate Serial Number: ${trustpoint.caCert!.serialNumber}`);
    expect(out).toContain('Key Usage: Not Set');
  });

  it('the verbose form carries the issuer, validity and the fingerprints of the DER', async () => {
    const l = await lab();
    const trustpoint = getSecurityConfig(l.r1).pkiTrustpoints.get('TP')!;
    const out = await l.r1.executeCommand('show crypto pki certificates TP verbose');
    const fingerprints = certificateFingerprints(trustpoint.localCert!);
    expect(out).toContain(`Fingerprint MD5: ${fingerprints.md5}`);
    expect(out).toContain(`Fingerprint SHA1: ${fingerprints.sha1}`);
    expect(out).toContain('Associated Trustpoints: TP');
    expect(out).toMatch(/start date: \d\d:\d\d:\d\d GMT \w{3} \d+ \d{4}/);
    expect(out).not.toContain('365 days');
  });

  it('the alias show crypto ca certificates answers the same', async () => {
    const l = await lab();
    expect(await l.r1.executeCommand('show crypto ca certificates')).toBe(await l.r1.executeCommand('show crypto pki certificates'));
  });

  it('pem prints certificates that parse back to the ones the trustpoint holds', async () => {
    const l = await lab();
    const trustpoint = getSecurityConfig(l.r1).pkiTrustpoints.get('TP')!;
    const out = await l.r1.executeCommand('show crypto pki certificates pem TP');
    expect(out).toContain('------Trustpoint: TP------');
    const blocks = out.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!;
    expect(blocks).toHaveLength(2);
    expect(pemToCert(blocks[0])!.serialNumber).toBe(trustpoint.caCert!.serialNumber);
    expect(pemToCert(blocks[1])!.serialNumber).toBe(trustpoint.localCert!.serialNumber);
  });

  it('non-regression: an unknown trustpoint is refused by name', async () => {
    const l = await lab();
    expect(await l.r1.executeCommand('show crypto pki certificates NOPE')).toContain('NOPE');
  });
});
