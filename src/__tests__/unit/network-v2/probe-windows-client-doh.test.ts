/**
 * Sonde — le client DNS de Windows interroge en DNS sur HTTPS (RFC 8484) un serveur dont la liste
 * `Add-DnsClientDohServerAddress` porte un modele.
 *
 * Mesure avant correction : `Add-DnsClientDohServerAddress -AutoUpgrade` etait rangee dans le registre (HKLM\...\Dnscache\Parameters\
 * DohWellKnownServers) et rendue par `Get-DnsClientDohServerAddress`, mais aucun octet DoH ne partait : le client interrogeait en UDP/53
 * comme si l'entree n'existait pas. `-AllowFallbackToUdp` ne decidait de rien non plus. Sur le serveur, l'UDP/53 est coupe (iptables),
 * si bien que seul un echange HTTPS peut aboutir. Le nom du modele est verifie dans le certificat, et le client n'approuve que
 * `Cert:\LocalMachine\Root` : `Import-Certificate` (qui n'existait pas) y range l'autorite.
 *
 * Cinq cas ajoutes pour le lecteur `Cert:` (Get-ChildItem, Get-Item, Test-Path, Remove-Item sur LocalMachine\\Root et \\My, avec la vraie
 * empreinte SHA-1) et un pour `netsh dnsclient show encryption`, qui rendait un texte fige « Disabled » quel que soit le registre : avant
 * (git stash push -- src/network src/powershell sur le commit qui livre le client DoH) 6 cas sur 16 tombent, les dix autres sont les cas
 * du client DoH deja livres et leurs temoins.
 *
 * Premiere livraison (git stash push -- src/network src/powershell) : 4 cas sur 9 tombent : l'echange DoH avec autorite importee (rien ne
 * partait en HTTPS), l'autorite non importee sans repli (l'UDP ouvert repondait quand meme), le modele au nom etranger sans repli (idem),
 * et Import-Certificate (la cmdlet n'existait pas). Passent des deux cotes : les deux temoins (UDP ouvert sans entree, la resolution
 * aboutit ; UDP ferme sans entree, rien n'aboutit), l'entree sans AutoUpgrade (elle n'agit pas), le repli autorise sur un UDP ouvert
 * et le repli autorise sur un UDP ferme ; ces deux derniers sont des controles de non-regression de la chaine de repli.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const SERVER_IP = '10.0.0.20';
const WIN_IP = '10.0.0.100';
const NAME = 'ns1.banquehorizon.com';
const PKI = '/etc/bind/tls';
const CA_PATH = 'C:\\ca.pem';
const TEMPLATE = `https://${NAME}/dns-query`;
const LONG = 120_000;

const ZONE = [
  '$TTL 3600',
  '@ IN SOA ns1 hostmaster ( 1 7200 900 1209600 3600 )',
  '@ IN NS ns1',
  `ns1 IN A ${SERVER_IP}`,
  'www IN A 203.0.113.20', '',
].join('\n');

const vfsOf = (server: LinuxServer): VirtualFileSystem =>
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;

async function lab(options: { udpOpen: boolean }) {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const server = new LinuxServer('linux-server', 'NS1');
  const win = new WindowsPC('windows-pc', 'WIN');
  win.powerOn();
  win.setCurrentUser('Administrator');
  const mask = new SubnetMask('255.255.255.0');
  [server, win].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([SERVER_IP, WIN_IP][index]), mask);
  });

  const sh = (command: string) => server.executeCommand(command);
  await sh(`mkdir -p ${PKI}`);
  await sh(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${PKI}/ca.key -out ${PKI}/ca.pem -days 30 -subj "/CN=Test CA"`);
  await sh(`openssl req -newkey rsa:2048 -nodes -keyout ${PKI}/srv.key -out ${PKI}/srv.csr -subj "/CN=${NAME}"`);
  vfsOf(server).writeFile(`${PKI}/srv.ext`, `subjectAltName=DNS:${NAME},IP:${SERVER_IP}\n`, 0, 0, 0o022);
  await sh(`openssl x509 -req -in ${PKI}/srv.csr -CA ${PKI}/ca.pem -CAkey ${PKI}/ca.key -CAcreateserial -out ${PKI}/srv.pem -days 30 -extfile ${PKI}/srv.ext`);
  vfsOf(server).writeFile('/etc/bind/named.conf', [
    `tls local-tls { key-file "${PKI}/srv.key"; cert-file "${PKI}/srv.pem"; };`,
    'options { listen-on port 443 tls local-tls http default { any; }; recursion no; };',
    'zone "banquehorizon.com" { type primary; file "/etc/bind/db.bh"; };', '',
  ].join('\n'), 0, 0, 0o022);
  vfsOf(server).writeFile('/etc/bind/db.bh', ZONE, 0, 0, 0o022);
  await sh('systemctl start named');
  if (!options.udpOpen) await sh('iptables -A INPUT -p udp --dport 53 -j DROP');

  win.getFileSystem().createFile(CA_PATH, vfsOf(server).readFile(`${PKI}/ca.pem`) ?? '');
  const shell = PowerShellSubShell.create(win).subShell;
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  const resolve = () => ps(`Resolve-DnsName www.banquehorizon.com -Server ${SERVER_IP} -Type A`);
  const configure = (flags: string) => ps(`Add-DnsClientDohServerAddress -ServerAddress ${SERVER_IP} -DohTemplate ${TEMPLATE} ${flags}`);
  const trustAuthority = () => ps(`Import-Certificate -FilePath ${CA_PATH} -CertStoreLocation Cert:\\LocalMachine\\Root`);
  return { ps, resolve, configure, trustAuthority };
}

describe('client DNS de Windows en DNS sur HTTPS', () => {
  it('temoin : UDP ouvert, aucune entree DoH, la resolution aboutit', async () => {
    const { resolve } = await lab({ udpOpen: true });
    expect(await resolve()).toContain('203.0.113.20');
  }, LONG);

  it('temoin : UDP ferme, aucune entree DoH, rien n\'aboutit', async () => {
    const { resolve } = await lab({ udpOpen: false });
    expect(await resolve()).not.toContain('203.0.113.20');
  }, LONG);

  it('AutoUpgrade et autorite importee : l\'echange passe par HTTPS alors que l\'UDP est ferme', async () => {
    const { resolve, configure, trustAuthority } = await lab({ udpOpen: false });
    await trustAuthority();
    await configure('-AutoUpgrade');
    expect(await resolve()).toContain('203.0.113.20');
  }, LONG);

  it('sans AutoUpgrade l\'entree n\'agit pas : l\'UDP ferme coupe la resolution', async () => {
    const { resolve, configure, trustAuthority } = await lab({ udpOpen: false });
    await trustAuthority();
    await configure('');
    expect(await resolve()).not.toContain('203.0.113.20');
  }, LONG);

  it('autorite non importee et pas de repli : le certificat est refuse, rien n\'aboutit', async () => {
    const { resolve, configure } = await lab({ udpOpen: true });
    await configure('-AutoUpgrade');
    expect(await resolve()).not.toContain('203.0.113.20');
  }, LONG);

  it('autorite non importee, repli autorise et UDP ouvert : la resolution aboutit par UDP', async () => {
    const { resolve, configure } = await lab({ udpOpen: true });
    await configure('-AutoUpgrade -AllowFallbackToUdp');
    expect(await resolve()).toContain('203.0.113.20');
  }, LONG);

  it('autorite non importee, repli autorise mais UDP ferme : rien n\'aboutit', async () => {
    const { resolve, configure } = await lab({ udpOpen: false });
    await configure('-AutoUpgrade -AllowFallbackToUdp');
    expect(await resolve()).not.toContain('203.0.113.20');
  }, LONG);

  it('un modele dont le nom n\'est pas celui du certificat est refuse, sans repli sur l\'UDP', async () => {
    const { resolve, ps, trustAuthority } = await lab({ udpOpen: true });
    await trustAuthority();
    await ps(`Add-DnsClientDohServerAddress -ServerAddress ${SERVER_IP} -DohTemplate https://autre.example/dns-query -AutoUpgrade`);
    expect(await resolve()).not.toContain('203.0.113.20');
  }, LONG);

  it('Import-Certificate range l\'autorite dans la racine locale et refuse ce qui n\'est ni un certificat ni la racine', async () => {
    const { ps, trustAuthority } = await lab({ udpOpen: true });
    expect(await trustAuthority()).toMatch(/Subject\s+:\s+CN=Test CA/);
    expect(await ps('Import-Certificate -FilePath C:\\absent.pem -CertStoreLocation Cert:\\LocalMachine\\Root')).toContain("Cannot find path 'C:\\absent.pem'");
    expect(await ps(`Import-Certificate -FilePath ${CA_PATH} -CertStoreLocation Cert:\\CurrentUser\\My`)).toContain('cannot receive a certificate without a private key');
  }, LONG);
});

describe('Cert: lecteur de magasins de certificats', () => {
  const THUMBPRINT = /^[0-9A-F]{40}$/m;

  it('temoin : la racine locale est vide avant l\'import, puis porte l\'autorite importee avec sa vraie empreinte', async () => {
    const { ps, trustAuthority } = await lab({ udpOpen: true });
    expect(await ps('Get-ChildItem Cert:\\LocalMachine\\Root')).not.toContain('CN=Test CA');
    await trustAuthority();
    const listing = await ps('Get-ChildItem Cert:\\LocalMachine\\Root');
    expect(listing).toContain('PSParentPath: Microsoft.PowerShell.Security\\Certificate::LocalMachine\\Root');
    expect(listing).toMatch(/Thumbprint\s+Subject/);
    expect(listing).toMatch(/^[0-9A-F]{40}\s+CN=Test CA$/m);
  }, LONG);

  it('la meme empreinte sort de Import-Certificate, du lecteur Cert: et de Get-Item', async () => {
    const { ps, trustAuthority } = await lab({ udpOpen: true });
    const imported = await trustAuthority();
    const thumbprint = /Thumbprint\s+:\s+([0-9A-F]{40})/.exec(imported)?.[1];
    expect(thumbprint).toMatch(/^[0-9A-F]{40}$/);
    expect(await ps(`Get-Item Cert:\\LocalMachine\\Root\\${thumbprint}`)).toContain('CN=Test CA');
    expect(await ps(`Test-Path Cert:\\LocalMachine\\Root\\${thumbprint}`)).toBe('True');
    expect(await ps(`Test-Path Cert:\\LocalMachine\\Root\\${'0'.repeat(40)}`)).toBe('False');
    expect(await ps('Test-Path Cert:\\LocalMachine\\Root')).toBe('True');
    expect(await ps('Test-Path Cert:\\LocalMachine\\Nope')).toBe('False');
  }, LONG);

  it('Remove-Item retire l\'autorite : le client DoH cesse de lui faire confiance', async () => {
    const { ps, resolve, configure, trustAuthority } = await lab({ udpOpen: false });
    const thumbprint = /Thumbprint\s+:\s+([0-9A-F]{40})/.exec(await trustAuthority())?.[1];
    await configure('-AutoUpgrade');
    expect(await resolve()).toContain('203.0.113.20');
    await ps(`Remove-Item Cert:\\LocalMachine\\Root\\${thumbprint}`);
    expect(await ps(`Test-Path Cert:\\LocalMachine\\Root\\${thumbprint}`)).toBe('False');
    expect(await resolve()).not.toContain('203.0.113.20');
  }, LONG);

  it('le magasin personnel montre le certificat de New-SelfSignedCertificate sous la meme empreinte', async () => {
    const { ps } = await lab({ udpOpen: true });
    const created = await ps('New-SelfSignedCertificate -DnsName web.banquehorizon.com');
    const thumbprint = /Thumbprint\s+:\s+([0-9A-F]{40})/.exec(created)?.[1];
    expect(thumbprint).toMatch(THUMBPRINT);
    const listing = await ps('Get-ChildItem Cert:\\LocalMachine\\My');
    expect(listing).toContain(thumbprint);
    expect(listing).toContain('CN=web.banquehorizon.com');
  }, LONG);

  it('un magasin inconnu est refuse comme un chemin inexistant, et les magasins se listent', async () => {
    const { ps } = await lab({ udpOpen: true });
    expect(await ps('Get-ChildItem Cert:\\LocalMachine\\Nope')).toContain("Cannot find path 'Cert:\\LocalMachine\\Nope' because it does not exist.");
    const stores = await ps('Get-ChildItem Cert:\\LocalMachine');
    for (const name of ['CA', 'My', 'Root']) expect(stores).toContain(name);
  }, LONG);
});

describe('netsh dnsclient show encryption', () => {
  it('rend l\'etat que Add-DnsClientDohServerAddress a range, au lieu d\'un texte fige', async () => {
    const { ps, configure } = await lab({ udpOpen: true });
    const before = await ps('netsh dnsclient show encryption');
    expect(before).toContain('Auto-upgrade:          Disabled');
    await configure('-AutoUpgrade');
    const after = await ps('netsh dnsclient show encryption');
    expect(after).toContain('DNS over HTTPS (DoH):  Enabled');
    expect(after).toContain('Auto-upgrade:          Enabled');
    expect(after).toContain('No encryption fallback: Enabled');
  }, LONG);

  it('un repli sur l\'UDP autorise leve « No encryption fallback »', async () => {
    const { ps, configure } = await lab({ udpOpen: true });
    await configure('-AutoUpgrade -AllowFallbackToUdp');
    expect(await ps('netsh dnsclient show encryption')).toContain('No encryption fallback: Disabled');
  }, LONG);
});
