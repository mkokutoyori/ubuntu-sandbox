/**
 * L'autorite de certification d'entreprise (role AD-Certificate, Install-AdcsCertificationAuthority) n'etait pas
 * sauvegardee : apres reouverture le role etait installe mais sans autorite, `Install-AdcsCertificationAuthority`
 * en fabriquait une NOUVELLE avec une autre cle, et plus aucun certificat emis avant la sauvegarde ne se verifiait
 * contre elle. Les compteurs de numeros de serie de pki/ repartaient aussi de leur base, si bien qu'un certificat
 * emis apres la reouverture pouvait porter le numero d'un certificat restaure et l'ecraser dans un magasin indexe
 * par numero de serie (un chargement de page neuf remet les deux compteurs a leur base).
 *
 * MESURE : CA1 avec AD-Certificate, une AC "Lab Root CA", un certificat WebServer emis par certreq -submit, lie a
 * IIS sur 8443 ; sauvegarde puis reouverture :
 *   - `Get-CATemplate` / certreq repondaient « The RPC server is unavailable » (aucune autorite) ;
 *   - une nouvelle installation de l'AC reussissait au lieu d'etre refusee, avec une autre cle ;
 *   - le certificat emis ne se verifiait plus contre l'AC (la cle du nouvel emetteur n'etait pas la sienne) ;
 *   - un New-SelfSignedCertificate fait apres un chargement neuf reprenait le numero de serie d'un certificat
 *     restaure et l'ecrasait dans Cert:\LocalMachine\My.
 *
 * Corrige : WindowsAdcsRole.exportState/restoreState (l'autorite est adoptee par CertificateAuthority.fromKeyPair,
 * le chemin de signature existant, avec les certificats emis) ecrits par un RolePersister en PEM via pki/pem.ts, et
 * toute restauration de certificat reserve son numero de serie aupres des deux compteurs de pki/
 * (serialReservation.ts). La revocation n'est pas ecrite : le role n'expose aucune revocation, ecrire un etat que
 * rien ne produit serait un critere stocke et jamais evalue.
 *
 * Discriminee contre l'etat d'avant (`git stash` de src/store et src/network) : 7 cas sur 9 tombent. Les 2 qui
 * passent des deux cotes sont des temoins : « rien a ecrire sans autorite » et « l'autorite n'emet jamais deux fois
 * le meme numero ». Le cas de reservation des numeros de serie est en outre discrimine seul : avec une reservation
 * vide (fonction neutralisee) il tombe aussi, le compteur d'un chargement neuf reprenant le numero du certificat
 * restaure.
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
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { createRequest } from '@/network/http/semantics/types';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import type { Equipment } from '@/network';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const SERVER_IP = '192.168.86.10';

const shellOf = (device: WindowsServer) => {
  const sub = PowerShellSubShell.create(device).subShell;
  return async (line: string): Promise<string> => (await sub.processLine(line)).output.join('\n');
};

async function buildLab(options: { authority?: boolean } = {}) {
  const { authority = true } = options;
  const server = new WindowsServer('CA1');
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
  await ps('Install-WindowsFeature AD-Certificate');
  await ps('Install-WindowsFeature Web-Server');
  await ps('Get-Website');
  if (authority) {
    await ps('Install-AdcsCertificationAuthority -CACommonName "Lab Root CA"');
    await server.executeCmdCommand('certreq -submit -template WebServer -subject "CN=www.lab.local"');
  }
  return { server, client, hub, all: [server, client, hub] as Equipment[], connections, ps };
}

const exportOf = (devices: Equipment[], connections: Parameters<typeof exportTopology>[2]) =>
  exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), connections);

async function reopen(json: ReturnType<typeof exportOf>) {
  const back = await importTopology(JSON.parse(JSON.stringify(json)));
  const byName = new Map([...back.deviceInstances.values()].map((d) => [d.getName(), d]));
  const server = byName.get('CA1') as WindowsServer;
  server.setCurrentUser('Administrator');
  return { server, client: byName.get('CLIENT1') as LinuxPC, ps: shellOf(server) };
}

describe('a server with the role but no authority writes nothing about it', () => {
  it('witness: no ADCS section', async () => {
    const lab = await buildLab({ authority: false });
    const [entry] = exportOf(lab.all, lab.connections).devices;
    expect(entry.windowsRoles?.adcs).toBeUndefined();
  });
});

describe('the authority and what it issued are back', () => {
  it('the authority is installed again, with the same name and the same certificate', async () => {
    const lab = await buildLab();
    const before = lab.server.getAdcsRole()!.getCaCertificate()!;
    const { server } = await reopen(exportOf(lab.all, lab.connections));
    const role = server.getAdcsRole()!;
    expect(role.isInstalled()).toBe(true);
    expect(role.getCaCommonName()).toBe('Lab Root CA');
    expect(role.getCaCertificate()!.serialNumber).toBe(before.serialNumber);
    expect(role.getCaCertificate()!.publicKey).toEqual(before.publicKey);
  });

  it('installing a second authority is refused instead of replacing the first with another key', async () => {
    const lab = await buildLab();
    const { ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps('Install-AdcsCertificationAuthority -CACommonName "Another CA"')).toContain('already installed');
  });

  it('a certificate issued before the save still verifies against the reopened authority', async () => {
    const lab = await buildLab();
    const { server } = await reopen(exportOf(lab.all, lab.connections));
    const role = server.getAdcsRole()!;
    const [issued] = role.listIssuedCertificates();
    expect(issued.subject).toBe('CN=www.lab.local');
    expect(new CertificateVerifier({ trustAnchors: [role.getCaCertificate()!] }).verify(issued).ok).toBe(true);
  });

  it('the reopened authority signs with the same key: a new certificate chains to the same root', async () => {
    const lab = await buildLab();
    const { server } = await reopen(exportOf(lab.all, lab.connections));
    const role = server.getAdcsRole()!;
    const fresh = role.submitRequest('CN=api.lab.local', 'WebServer');
    expect(fresh.ok).toBe(true);
    const verifier = new CertificateVerifier({ trustAnchors: [lab.server.getAdcsRole()!.getCaCertificate()!] });
    expect(verifier.verify(fresh.certificate!).ok).toBe(true);
    expect(role.listIssuedCertificates()).toHaveLength(2);
  });

  it('the templates answer and certreq works without any reinstallation', async () => {
    const lab = await buildLab();
    const { server, ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps('Get-CATemplate | Select-Object -ExpandProperty Name')).toContain('WebServer');
    expect(await server.executeCmdCommand('certreq -submit -template WebServer -subject "CN=two.lab.local"')).toMatch(/Certificate Retrieved/);
  });

  it('end to end: a certificate the authority issued and IIS serves is still trusted by a client holding the root', async () => {
    const lab = await buildLab();
    const role = lab.server.getAdcsRole()!;
    const issued = role.listIssuedCertificates()[0];
    const thumbprint = lab.server.getCertStore().list()[0]?.serialNumber ?? issued.serialNumber;
    expect(thumbprint).toBeTruthy();
    await lab.ps(`New-WebBinding -Name "Default Web Site" -Protocol https -Port 8443 -CertificateHash "${thumbprint}"`);
    const { server, client } = await reopen(exportOf(lab.all, lab.connections));
    const verifier = new CertificateVerifier({ trustAnchors: [server.getAdcsRole()!.getCaCertificate()!] });
    const result = new HttpsClientSession(client.getTcpStack(), SERVER_IP, 8443, { verifier }).send(createRequest('GET', '/'));
    expect(result.ok).toBe(true);
  });
});

describe('serial numbers stay unique across a reopening', () => {
  it('the serial of a restored certificate is never handed out again by the next one', async () => {
    const lab = await buildLab({ authority: false });
    const probe = generateSelfSignedCertificate('CN=probe', { now: Date.now() });
    const taken = (BigInt(`0x${probe.cert.serialNumber}`) + 1n).toString(16).padStart(16, '0');
    const foreign = CertificateAuthority.generate('CN=Other CA', { now: Date.now() }).issueCertificate({
      subject: 'CN=restored.lab.local', notBefore: Date.now(), notAfter: Date.now() + 86_400_000, serialNumber: taken,
    });
    lab.server.getCertStore().add(foreign.cert, foreign.privateKey);
    const { server, ps } = await reopen(exportOf(lab.all, lab.connections));
    await ps('New-SelfSignedCertificate -DnsName two.lab.local');
    const serials = server.getCertStore().list().map((c) => c.serialNumber);
    expect(serials).toContain(taken);
    expect(new Set(serials).size).toBe(serials.length);
    expect(serials).toHaveLength(2);
  });

  it('witness: the authority never issues the same serial twice, reopened or not', async () => {
    const lab = await buildLab();
    const { server } = await reopen(exportOf(lab.all, lab.connections));
    const role = server.getAdcsRole()!;
    role.submitRequest('CN=x.lab.local', 'WebServer');
    const serials = role.listIssuedCertificates().map((c) => c.serialNumber);
    expect(new Set(serials).size).toBe(serials.length);
  });
});
