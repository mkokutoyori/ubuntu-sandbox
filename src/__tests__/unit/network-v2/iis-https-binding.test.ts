/**
 * IIS HTTPS/TLS binding — PRD-Windows-Server-Advanced.md §5 P14, §2.1.14.
 * Zero new TLS primitive: `New-WebBinding -Protocol https` stands up a
 * real `HttpsServerSession`/`TlsServerSession` handshake on the
 * configured port, using a certificate from the device's personal store
 * (issued by AD CS §5 P13, or `New-SelfSignedCertificate`) — exactly the
 * same engine `https.test.ts` already exercises directly, just reached
 * through the IIS role instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { createRequest } from '@/network/http/semantics/types';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan() {
  const srv1 = new WindowsServer('SRV1');
  const linuxClient = new LinuxPC('linux-pc', 'LINUXCLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(srv1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(linuxClient.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  srv1.getPorts()[0].configureIP(new IPAddress('192.168.86.10'), mask);
  linuxClient.getPorts()[0].configureIP(new IPAddress('192.168.86.20'), mask);
  srv1.setCurrentUser('Administrator');
  await run(ps(srv1), 'Install-WindowsFeature Web-Server');
  await run(ps(srv1), 'Get-Website'); // triggers the lazy role/listener creation
  return { srv1, linuxClient };
}

describe('New-WebBinding -Protocol https (§5 P14) — certificate issued by AD CS', () => {
  it('a real TLS 1.3 handshake succeeds against a trusted CA, serving identical content to HTTP', async () => {
    const { srv1, linuxClient } = await buildLan();
    await run(ps(srv1), 'Install-WindowsFeature AD-Certificate');
    await run(ps(srv1), 'Install-AdcsCertificationAuthority -CACommonName "Lab Root CA"');
    const certOut = await srv1.executeCmdCommand('certreq -submit -template WebServer -subject "CN=srv1.lab.local"');
    const thumbprint = /Serial Number: (\S+)/.exec(certOut)?.[1];
    expect(thumbprint).toBeDefined();

    const bindOut = await run(ps(srv1), `New-WebBinding -Name "Default Web Site" -Protocol https -Port 8443 -CertificateHash "${thumbprint}"`);
    expect(bindOut).toContain('Default Web Site');
    expect(bindOut).toContain('8443');

    const caCert = srv1.getAdcsRole()!.getCaCertificate()!;
    const verifier = new CertificateVerifier({ trustAnchors: [caCert] });
    const client = new HttpsClientSession(linuxClient.getTcpStack(), '192.168.86.10', 8443, { verifier });
    const result = client.send(createRequest('GET', '/'));

    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.response!.body!)).toContain('IIS Windows Server');

    const httpBody = await linuxClient.executeCommand('curl http://192.168.86.10/');
    expect(httpBody).toContain('IIS Windows Server');
  });
});

describe('New-WebBinding -Protocol https (§5 P14) — self-signed certificate', () => {
  it('New-SelfSignedCertificate + New-WebBinding produces a working HTTPS listener', async () => {
    const { srv1, linuxClient } = await buildLan();
    const certOut = await run(ps(srv1), 'New-SelfSignedCertificate -DnsName srv1.lab.local | Select-Object -ExpandProperty Thumbprint');
    const thumbprint = certOut.trim();
    expect(thumbprint.length).toBeGreaterThan(0);

    await run(ps(srv1), `New-WebBinding -Name "Default Web Site" -Protocol https -Port 8443 -CertificateHash "${thumbprint}"`);

    const entry = srv1.getCertStore().get(thumbprint)!;
    const verifier = new CertificateVerifier({ trustAnchors: [entry.cert] });
    const client = new HttpsClientSession(linuxClient.getTcpStack(), '192.168.86.10', 8443, { verifier });
    const result = client.send(createRequest('GET', '/'));

    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.response!.body!)).toContain('IIS Windows Server');
  });

  it('fails cleanly when the client does not trust the binding\'s certificate', async () => {
    const { srv1, linuxClient } = await buildLan();
    const certOut = await run(ps(srv1), 'New-SelfSignedCertificate -DnsName srv1.lab.local | Select-Object -ExpandProperty Thumbprint');
    const thumbprint = certOut.trim();
    await run(ps(srv1), `New-WebBinding -Name "Default Web Site" -Protocol https -Port 8443 -CertificateHash "${thumbprint}"`);

    const rogueCert = generateSelfSignedCertificate('CN=rogue-ca', { now: Date.now() });
    const rogueVerifier = new CertificateVerifier({ trustAnchors: [rogueCert.cert] });
    const client = new HttpsClientSession(linuxClient.getTcpStack(), '192.168.86.10', 8443, { verifier: rogueVerifier });
    const result = client.send(createRequest('GET', '/'));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/TLS handshake/i);
  });

  it('fails cleanly when the bound certificate has already expired', async () => {
    const { srv1, linuxClient } = await buildLan();
    const expired = generateSelfSignedCertificate('CN=old.lab.local', {
      now: Date.now() - 400 * 24 * 3600 * 1000, validityMs: 30 * 24 * 3600 * 1000,
    });
    const thumbprint = srv1.getCertStore().add(expired.cert, expired.privateKey);
    await run(ps(srv1), `New-WebBinding -Name "Default Web Site" -Protocol https -Port 8443 -CertificateHash "${thumbprint}"`);

    const verifier = new CertificateVerifier({ trustAnchors: [expired.cert] });
    const client = new HttpsClientSession(linuxClient.getTcpStack(), '192.168.86.10', 8443, { verifier });
    const result = client.send(createRequest('GET', '/'));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/TLS handshake/i);
  });
});

describe('New-WebBinding validation', () => {
  it('rejects https bindings for an unknown certificate hash', async () => {
    const { srv1 } = await buildLan();
    const out = await run(ps(srv1), 'New-WebBinding -Name "Default Web Site" -Protocol https -Port 8443 -CertificateHash "deadbeef"');
    expect(out).toMatch(/Cannot find the certificate hash/);
  });

  it('rejects an unknown site name', async () => {
    const { srv1 } = await buildLan();
    const certOut = await run(ps(srv1), 'New-SelfSignedCertificate -DnsName srv1.lab.local | Select-Object -ExpandProperty Thumbprint');
    const out = await run(ps(srv1), `New-WebBinding -Name Ghost -Protocol https -Port 8443 -CertificateHash "${certOut.trim()}"`);
    expect(out).toMatch(/does not exist/);
  });
});
