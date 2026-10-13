/**
 * Le role Web Server (IIS) ne gardait rien d'une sauvegarde a l'autre : les sites crees (New-Website), leur etat
 * Started/Stopped, leurs liaisons HTTPS (New-WebBinding), les pools d'applications crees ou arretes et leur compteur
 * de recyclage revenaient a l'etat d'usine (Default Web Site seul, DefaultAppPool seul), et le magasin de
 * certificats de la machine (Cert:\LocalMachine\My, certificat ET cle privee) n'etait ecrit nulle part, si bien
 * qu'une liaison HTTPS n'aurait de toute facon rien eu a servir.
 *
 * MESURE : SRV1 avec le role Web-Server, un certificat auto-signe, un site Blog sur le port 8080, une liaison HTTPS
 * sur 8443 pour Default Web Site, un pool Blog (identite NetworkService), le pool Blog arrete puis DefaultAppPool
 * recycle, puis sauvegarde et reouverture : `Get-Website` ne listait que Default Web Site,
 * `Get-IISAppPool` que DefaultAppPool (recycleCount 0), `Cert:` ne contenait plus le certificat, le port 8080
 * refusait la connexion, le port 8443 aussi.
 *
 * Corrige : le role sait exporter/importer l'etat qui differe de l'etat d'usine (WindowsIisRole.restoreState, ecrit
 * par un RolePersister contre le jumeau d'usine : sites et pools qui different, sites et pools disparus) ; le
 * magasin de certificats est ecrit en PEM (certificat et cle PKCS#8, via les codecs DER/PEM de pki/pem.ts que le
 * developpement d'openssl a etoffes : aucun second codec) contre le jumeau, vide, avec les ancres de confiance
 * (Cert:\LocalMachine\Root) et les identites TLS que la machine se fabrique une fois (RDP, LDAP StartTLS) ; les
 * fichiers du contenu des sites sont deja ecrits par le delta de fichiers. Une liaison HTTPS est rejouee sur le
 * magasin restaure, et c'est une vraie poignee de main TLS depuis un client Linux qui le prouve.
 *
 * Discriminee contre l'etat d'avant (`git stash` de src/store et src/network) : 11 cas sur 14 tombent. Les 3 qui
 * passent des deux cotes sont des temoins « rien a ecrire » : un IIS intact, une machine sans certificat, une machine
 * dont l'identite RDP n'a jamais ete creee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildConnection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { createRequest } from '@/network/http/semantics/types';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import type { Equipment } from '@/network';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const SERVER_IP = '192.168.86.10';

const shellOf = (device: WindowsServer) => {
  const sub = PowerShellSubShell.create(device).subShell;
  return async (line: string): Promise<string> => (await sub.processLine(line)).output.join('\n');
};

async function buildLab(options: { configure?: boolean } = {}) {
  const { configure = true } = options;
  const server = new WindowsServer('SRV1');
  const client = new LinuxPC('linux-pc', 'CLIENT1');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  const connections = [
    buildConnection(server, server.getPorts()[0].getName(), hub, hub.getPorts()[0].getName(), 'ethernet')!,
    buildConnection(client, client.getPorts()[0].getName(), hub, hub.getPorts()[1].getName(), 'ethernet')!,
  ];
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SERVER_IP), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.86.20'), mask);
  server.setCurrentUser('Administrator');
  const ps = shellOf(server);
  await ps('Install-WindowsFeature Web-Server');
  await ps('Get-Website');
  let thumbprint = '';
  if (configure) {
    thumbprint = (await ps('New-SelfSignedCertificate -DnsName srv1.lab.local | Select-Object -ExpandProperty Thumbprint')).trim();
    server.getFileSystem().mkdirp('C:\\inetpub\\blog');
    server.getFileSystem().createFile('C:\\inetpub\\blog\\iisstart.htm', '<html><body>Blog home</body></html>');
    await ps('New-Website -Name Blog -PhysicalPath "C:\\inetpub\\blog" -Port 8080');
    await ps(`New-WebBinding -Name "Default Web Site" -Protocol https -Port 8443 -CertificateHash "${thumbprint}"`);
    await ps('New-WebAppPool -Name BlogPool');
    await ps('Stop-WebAppPool -Name BlogPool');
    await ps('Restart-WebAppPool -Name DefaultAppPool');
  }
  return { server, client, hub, all: [server, client, hub] as Equipment[], connections, ps, thumbprint };
}

const exportOf = (devices: Equipment[], connections: Parameters<typeof exportTopology>[2]) =>
  exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), connections);

async function reopen(json: ReturnType<typeof exportOf>) {
  const back = await importTopology(JSON.parse(JSON.stringify(json)));
  const byName = new Map([...back.deviceInstances.values()].map((d) => [d.getName(), d]));
  const server = byName.get('SRV1') as WindowsServer;
  const client = byName.get('CLIENT1') as LinuxPC;
  server.setCurrentUser('Administrator');
  return { server, client, ps: shellOf(server) };
}

const httpGet = (client: LinuxPC, port: number) => {
  const result = new Http1ClientSession(client.getTcpStack(), SERVER_IP, port).send(createRequest('GET', '/'));
  return { ok: result.ok, status: result.response?.statusCode, body: result.response?.body ? new TextDecoder().decode(result.response.body) : '' };
};

describe('an IIS server left as installed writes nothing about IIS', () => {
  it('witness: no IIS section, no certificate', async () => {
    const lab = await buildLab({ configure: false });
    const [entry] = exportOf(lab.all, lab.connections).devices;
    expect(entry.windowsRoles).toBeUndefined();
    expect(entry.windowsCertificates).toBeUndefined();
  });
});

describe('sites, pools and bindings come back', () => {
  it('a site that was created is listed, started, and serves its content over the wire', async () => {
    const lab = await buildLab();
    expect(httpGet(lab.client, 8080)).toMatchObject({ ok: true, status: 200 });
    const { client, ps } = await reopen(exportOf(lab.all, lab.connections));
    const sites = await ps('Get-Website | Select-Object -ExpandProperty Name');
    expect(sites).toContain('Blog');
    expect(sites).toContain('Default Web Site');
    const reply = httpGet(client, 8080);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Blog home');
  });

  it('a stopped site stays stopped and answers nothing', async () => {
    const lab = await buildLab();
    await lab.ps('Stop-Website -Name Blog');
    const { client, ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps('Get-Website -Name Blog | Select-Object -ExpandProperty State')).toContain('Stopped');
    expect(httpGet(client, 8080).ok).toBe(false);
  });

  it('a removed site stays removed, including the default one', async () => {
    const lab = await buildLab();
    await lab.ps('Remove-Website -Name "Default Web Site"');
    const { client, ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps('Get-Website | Select-Object -ExpandProperty Name')).not.toContain('Default Web Site');
    expect(httpGet(client, 80).ok).toBe(false);
  });

  it('application pools keep their state and their recycle count', async () => {
    const lab = await buildLab();
    const { ps } = await reopen(exportOf(lab.all, lab.connections));
    const pools = await ps('Get-IISAppPool | Format-List Name, State, RecycleCount');
    expect(pools).toMatch(/Name\s*:\s*BlogPool[\s\S]*State\s*:\s*Stopped/);
    expect(pools).toMatch(/Name\s*:\s*DefaultAppPool[\s\S]*RecycleCount\s*:\s*1/);
  });

  it('the IIS section holds only what differs from a fresh IIS', async () => {
    const lab = await buildLab();
    const iis = exportOf(lab.all, lab.connections).devices[0].windowsRoles?.iis;
    expect(iis?.sites.map((s) => s.name).sort()).toEqual(['Blog', 'Default Web Site']);
    expect(iis?.appPools.map((p) => p.name).sort()).toEqual(['BlogPool', 'DefaultAppPool']);
    expect(iis?.removedSites).toEqual([]);
  });
});

describe('the certificate store and the HTTPS binding that depends on it', () => {
  it('the certificate and its private key are back under the same thumbprint', async () => {
    const lab = await buildLab();
    const before = lab.server.getCertStore().get(lab.thumbprint)!;
    const { server } = await reopen(exportOf(lab.all, lab.connections));
    const after = server.getCertStore().get(lab.thumbprint);
    expect(after).not.toBeNull();
    expect(after!.cert.subject).toBe(before.cert.subject);
    expect(after!.privateKey.algorithm).toBe(before.privateKey.algorithm);
  });

  it('the HTTPS binding completes a real TLS handshake and serves the default site', async () => {
    const lab = await buildLab();
    const entry = lab.server.getCertStore().get(lab.thumbprint)!;
    const { client } = await reopen(exportOf(lab.all, lab.connections));
    const verifier = new CertificateVerifier({ trustAnchors: [entry.cert] });
    const result = new HttpsClientSession(client.getTcpStack(), SERVER_IP, 8443, { verifier }).send(createRequest('GET', '/'));
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.response!.body!)).toContain('IIS Windows Server');
  });

  it('a machine with no certificate writes none', async () => {
    const lab = await buildLab({ configure: false });
    expect(exportOf(lab.all, lab.connections).devices[0].windowsCertificates).toBeUndefined();
  });

  it('the exported file carries the certificate as PEM and never a bare key object', async () => {
    const lab = await buildLab();
    const saved = exportOf(lab.all, lab.connections).devices[0].windowsCertificates!.personal!;
    expect(saved).toHaveLength(1);
    expect(saved[0].certificate).toContain('-----BEGIN CERTIFICATE-----');
    expect(saved[0].privateKey).toContain('-----BEGIN PRIVATE KEY-----');
  });
});

describe('the other certificates a Windows machine holds', () => {
  it('the trusted authorities of Cert:\\LocalMachine\\Root are back', async () => {
    const lab = await buildLab({ configure: false });
    const authority = generateSelfSignedCertificate('CN=lab-root-ca', { now: Date.now(), extensions: { basicConstraints: { cA: true }, keyUsage: ['keyCertSign', 'cRLSign'] } });
    lab.server.addTrustedCertificateAuthority(authority.cert);
    const { server } = await reopen(exportOf(lab.all, lab.connections));
    expect(server.getTrustedCertificateAuthorities().map((c) => c.serialNumber)).toEqual([authority.cert.serialNumber]);
  });

  it('the RDP identity of the machine is the same certificate after reopening', async () => {
    const lab = await buildLab({ configure: false });
    const serial = lab.server.getRdpTlsCertificate().serialNumber;
    const { server } = await reopen(exportOf(lab.all, lab.connections));
    expect(server.getRdpTlsCertificate().serialNumber).toBe(serial);
  });

  it('a machine whose RDP identity was never created does not invent one in the file', async () => {
    const lab = await buildLab({ configure: false });
    expect(exportOf(lab.all, lab.connections).devices[0].windowsCertificates).toBeUndefined();
  });

  it('the LDAP StartTLS identity of a domain controller is the one its clients already saw', async () => {
    const lab = await buildLab({ configure: false });
    const ps = lab.ps;
    await ps('Install-WindowsFeature AD-Domain-Services');
    await ps('Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    expect(dialLdap(lab.client.getTcpStack(), SERVER_IP).ok).toBe(true);
    const before = lab.server.getTlsIdentities().ldap!.cert.serialNumber;
    const { server } = await reopen(exportOf(lab.all, lab.connections));
    expect(server.getTlsIdentities().ldap?.cert.serialNumber).toBe(before);
  });
});
