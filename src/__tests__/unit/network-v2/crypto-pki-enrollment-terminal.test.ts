/**
 * Cisco IOS Security Command Reference: `enrollment terminal` (manual cut-and-paste enrollment). With it
 * `crypto pki authenticate TP` asks for the CA certificate to be pasted ("End with a blank line or the word
 * quit on a line by itself"), `crypto pki enroll TP` prints the certificate request in PEM for the operator to
 * take to the CA, and `crypto pki import TP certificate` takes the certificate the CA returned.
 *
 * Lab: R1 - R2 of the PKI lab, enrolled by hand with an offline CA (the repository's CertificateAuthority) that
 * is never cabled: the CSR and the certificates travel through the operator, as in the reference. The proof that
 * the pasted identity is real is the IKEv2 tunnel authenticated with it.
 *
 * Ours, not in the reference: the refusal wordings (no pending request, certificate for another key, certificate
 * not signed by the authenticated CA) are this simulator's own.
 *
 * Measured with src stashed to HEAD: every case falls (terminal trustpoints answered "no usable enrollment url"
 * and `import … certificate` stored a marker). Witness: none needed, the lab is proven by the tunnel case.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem, pemToCsr } from '@/network/pki/pem';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { CiscoRouter } from '@/network/devices/CiscoRouter';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';
import { buildLab, configureBase, configureX509Profile, seedPcs } from './_helpers/pkiIpsecLab';
import { paste, manualEnroll } from './_helpers/manualPki';
import { run } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function lab() {
  const l = await buildLab();
  await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
  await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
  const authority = CertificateAuthority.generate('CN=OfflineCA', { now: simulationNowMs() });
  return { ...l, authority };
}

describe('enrollment terminal', () => {
  it('authenticate asks for the CA certificate and prints its fingerprints', async () => {
    const l = await lab();
    const result = await manualEnroll(l.r1, l.authority, 'CN=r1.lab');
    expect(result.authenticated).toContain('Fingerprint MD5:');
    expect(result.authenticated).toContain('Trustpoint CA certificate accepted.');
    expect(getSecurityConfig(l.r1).pkiTrustpoints.get('TP')!.caCert!.serialNumber).toBe(l.authority.rootCertificate.serialNumber);
  });

  it('enroll prints a certificate request that carries the subject and is signed by the pending key', async () => {
    const l = await lab();
    const { csrText, issued } = await manualEnroll(l.r1, l.authority, 'CN=r1.lab');
    expect(csrText).toContain('Certificate Request follows:');
    expect(csrText).toContain('CN=r1.lab');
    expect(issued!.subject).toContain('r1.lab');
  });

  it('the pasted certificate completes the enrollment and IKE authenticates with it', async () => {
    const l = await lab();
    for (const [router, name] of [[l.r1, 'r1.lab'], [l.r2, 'r2.lab']] as const) {
      const { issued } = await manualEnroll(router, l.authority, `CN=${name}`);
      expect(await paste(router, 'crypto pki import TP certificate', certToPem(issued!))).toContain('successfully imported');
    }
    await configureX509Profile(l.r1, '10.0.12.2');
    await configureX509Profile(l.r2, '10.0.12.1');
    await seedPcs(l.pc1, l.pc2);
    expect(await clock.advanceUntilSettled(l.pc1.executeCommand('ping -c 2 192.168.2.10'))).toContain('2 received');
  });

  it('a certificate issued for another key is refused', async () => {
    const l = await lab();
    const first = await manualEnroll(l.r1, l.authority, 'CN=r1.lab');
    const other = await manualEnroll(l.r2, l.authority, 'CN=r2.lab');
    expect(first.issued).not.toBeNull();
    expect(await paste(l.r1, 'crypto pki import TP certificate', certToPem(other.issued!))).toContain('does not carry the public key');
    expect(getSecurityConfig(l.r1).pkiTrustpoints.get('TP')!.localCert).toBeUndefined();
  });

  it('importing without a pending request is refused', async () => {
    const l = await lab();
    await run(l.r1, ['crypto pki trustpoint TP', 'enrollment terminal', 'exit']);
    await paste(l.r1, 'crypto pki authenticate TP', certToPem(l.authority.rootCertificate));
    expect(await paste(l.r1, 'crypto pki import TP certificate', certToPem(l.authority.rootCertificate))).toContain('No certificate request is pending');
  });

  it('a certificate signed by another CA is refused', async () => {
    const l = await lab();
    const { csrText } = await manualEnroll(l.r1, l.authority, 'CN=r1.lab');
    const rogue = CertificateAuthority.generate('CN=OfflineCA', { now: simulationNowMs() });
    const forged = rogue.signRequest(pemToCsr(/-----BEGIN CERTIFICATE REQUEST-----[\s\S]*?-----END CERTIFICATE REQUEST-----/.exec(csrText)![0])!, { notBefore: simulationNowMs(), notAfter: simulationNowMs() + 86_400_000 });
    expect(await paste(l.r1, 'crypto pki import TP certificate', certToPem(forged!))).toContain('not signed by the authenticated CA');
  });
});
