/**
 * Cisco `crypto pki trustpoint`/`enroll`/`authenticate` produced realistic
 * output ("Certificate request sent...") but never called
 * CiscoRouter.installIkeCertAuth() — so configuring `authentication rsa-sig`
 * had zero effect on real negotiation (IkeOfferMessage.authMode only became
 * 'x509' when a cert was installed via direct test-only API calls).
 *
 * This drives the PKI flow entirely through real CLI commands and proves a
 * genuine IKEv2 tunnel establishes from real CA-issued certificates — and
 * that two trustpoints pointed at *different* CAs still correctly reject
 * each other, so this isn't just an always-pass shortcut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { buildLab, configureBase, buildCa, enrollTrustpoint, configureX509Profile, seedPcs } from './_helpers/pkiIpsecLab';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('crypto pki trustpoint — real CA enrollment wired to IKE cert auth', () => {
  it('enroll before authenticate is rejected (real IOS ordering)', async () => {
    const r1 = new CiscoRouter('R1');
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('crypto pki trustpoint TP');
    await r1.executeCommand('exit');
    const out = await r1.executeCommand('crypto pki enroll TP');
    expect(out).toMatch(/not authenticated/i);
  });

  it('authenticate + enroll install a real CA-issued cert (not "Pending enrollment")', async () => {
    const r1 = new CiscoRouter('R1');
    await buildCa('CA', [{ peer: r1, caIp: '10.9.0.1', peerIp: '10.9.0.2', caPort: 'GigabitEthernet0/0' }]);
    await enrollTrustpoint(r1, 'http://10.9.0.1', 'CN=r1.example.com');
    const certs = await r1.executeCommand('show crypto pki certificates');
    expect(certs).toContain('Status: Available');
    expect(certs).not.toContain('Pending enrollment');
    expect(certs).toContain('CN=r1.example.com');
    const tp = getSecurityConfig(r1).pkiTrustpoints.get('TP')!;
    expect(tp.localCert!.issuer).toContain('CA-CA');
  });

  it('two routers enrolling with the same CA URL establish a real IKEv2 tunnel over rsa-sig auth', async () => {
    const l = await buildLab();
    await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
    await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
    await buildCa('CA', [
      { peer: l.r1, caIp: '10.9.1.1', peerIp: '10.9.1.2', caPort: 'GigabitEthernet0/0' },
      { peer: l.r2, caIp: '10.9.2.1', peerIp: '10.9.2.2', caPort: 'GigabitEthernet0/1' },
    ]);
    await enrollTrustpoint(l.r1, 'http://10.9.1.1', 'CN=10.0.12.1');
    await enrollTrustpoint(l.r2, 'http://10.9.2.1', 'CN=10.0.12.2');
    await configureX509Profile(l.r1, '10.0.12.2');
    await configureX509Profile(l.r2, '10.0.12.1');
    await seedPcs(l.pc1, l.pc2);

    const ping = await pingOnSimulatedClock(l.pc1, 'ping -c 2 192.168.2.10');
    expect(ping).toContain('2 received');
    const sa = await l.r1.executeCommand('show crypto ikev2 sa');
    expect(sa).toMatch(/READY/);
  });

  it('routers enrolled with different CA URLs (different CAs) do not trust each other', async () => {
    const l = await buildLab();
    await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
    await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
    await buildCa('CA-A', [{ peer: l.r1, caIp: '10.9.1.1', peerIp: '10.9.1.2', caPort: 'GigabitEthernet0/0' }]);
    await buildCa('CA-B', [{ peer: l.r2, caIp: '10.9.2.1', peerIp: '10.9.2.2', caPort: 'GigabitEthernet0/0' }]);
    await enrollTrustpoint(l.r1, 'http://10.9.1.1', 'CN=10.0.12.1');
    await enrollTrustpoint(l.r2, 'http://10.9.2.1', 'CN=10.0.12.2');
    await configureX509Profile(l.r1, '10.0.12.2');
    await configureX509Profile(l.r2, '10.0.12.1');
    await seedPcs(l.pc1, l.pc2);

    await pingOnSimulatedClock(l.pc1, 'ping -c 1 192.168.2.10');
    const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
    expect(detail).toMatch(/Certificate unknown/i);
  });
});
