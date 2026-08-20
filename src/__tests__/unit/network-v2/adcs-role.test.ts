/**
 * AD CS (Certificate Services) role — PRD-Windows-Server-Advanced.md §5
 * P13, §2.1.13. No new cryptographic primitive: `WindowsAdcsRole`
 * delegates issuance/signing entirely to `CertificateAuthority` (`src/
 * network/pki/`, already mature); a certificate issued through `certreq
 * -submit`/`Get-Certificate` must be genuinely signed and verifiable by
 * `CertificateVerifier`, and a template's EKU restriction must actually
 * gate requests outside its scope.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildCaServer(): Promise<WindowsServer> {
  const dc = new WindowsServer('CA1');
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Certificate');
  await run(ps(dc), 'Install-AdcsCertificationAuthority -CACommonName "Lab Root CA"');
  return dc;
}

describe('AD CS role (§5 P13) — installation', () => {
  it('rejects certreq before the role is installed', async () => {
    const dc = new WindowsServer('CA1');
    dc.setCurrentUser('Administrator');
    const out = await dc.executeCmdCommand('certreq -submit -template WebServer -subject "CN=www.lab.local"');
    expect(out).toMatch(/RPC server is unavailable/);
  });

  it('installs the CA and lists the default certificate templates via Get-CATemplate', async () => {
    const dc = await buildCaServer();
    const out = await run(ps(dc), 'Get-CATemplate | Select-Object -ExpandProperty Name');
    expect(out).toMatch(/WebServer/);
    expect(out).toMatch(/User/);
    expect(out).toMatch(/ComputerSigned/);
  });
});

describe('AD CS role (§5 P13) — certificate issuance', () => {
  it('certreq -submit issues a certificate genuinely signed and verifiable by CertificateVerifier', async () => {
    const dc = await buildCaServer();
    const out = await dc.executeCmdCommand('certreq -submit -template WebServer -subject "CN=www.lab.local"');
    expect(out).toMatch(/Certificate Retrieved/);

    const role = dc.getAdcsRole();
    expect(role).not.toBeNull();
    const caCert = role!.getCaCertificate();
    expect(caCert).not.toBeNull();
    const [issued] = role!.listIssuedCertificates();
    expect(issued).toBeDefined();
    expect(issued.subject).toBe('CN=www.lab.local');
    expect(issued.extensions?.extKeyUsage).toEqual(['serverAuth']);

    const verifier = new CertificateVerifier({ trustAnchors: [caCert!] });
    const result = verifier.verify(issued);
    expect(result.ok).toBe(true);
  });

  it('rejects a request for a purpose outside the template\'s allowed EKU', async () => {
    const dc = await buildCaServer();
    const role = dc.getAdcsRole()!;
    const res = role.submitRequest('codesign.lab.local', 'WebServer', { requestedEku: 'codeSigning' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Denied by Policy Module/);
  });

  it('Get-Certificate submits and returns a certificate through the PowerShell surface', async () => {
    const dc = await buildCaServer();
    const out = await run(ps(dc), 'Get-Certificate -Template User -DnsName "alice.lab.local" | Select-Object -ExpandProperty Status');
    expect(out).toMatch(/Issued/);
  });
});
