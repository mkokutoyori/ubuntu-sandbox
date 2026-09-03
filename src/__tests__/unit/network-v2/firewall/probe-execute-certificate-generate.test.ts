/**
 * `execute vpn certificate local generate rsa` produit une VRAIE demande
 * de signature, et une autorite la signe.
 *
 * `executeCertificate` ne servait que `local export tftp` et repondait
 * « only `execute vpn certificate local export` is available here » a
 * tout le reste. Un apprenant ne pouvait donc pas faire sur le pare-feu
 * ce que la premiere etape de tout laboratoire de PKI demande — y creer
 * sa paire de cles et sa demande — il devait fabriquer le certificat
 * AILLEURS et le coller par `config vpn certificate local`, c'est-a-dire
 * sauter l'etape que la commande existe pour enseigner.
 *
 * Toute la matiere etait la : generation de cles RSA reelle, demande de
 * signature reelle, PEM reel, et un transfert TFTP qui fonctionne. Ce qui
 * manquait etait un magasin pour l'etat INTERMEDIAIRE — une demande n'est
 * pas un certificat, elle n'en a pas — et `LocalCertificate` EXIGE un
 * certificat. Une seconde carte de `CertificateStore` le porte, plutot
 * que de rendre le certificat facultatif sur celle qui existe : tous ses
 * lecteurs (le portail SSL-VPN, l'inspection profonde, IPsec) tiennent
 * pour acquis qu'un certificat est la, et le leur retirer aurait rendu
 * chacun d'eux capable de servir une demande non signee.
 *
 * L'observable est le bout de la chaine et non l'objet en memoire : le
 * pare-feu genere, exporte par TFTP sur un vrai serveur, et une autorite
 * montee avec `openssl` sur ce serveur SIGNE la demande. `Certificate
 * request self-signature ok` est ce qui prouve que la demande porte une
 * vraie signature de la cle que le pare-feu vient de fabriquer — un PEM
 * decoratif ne passerait pas cette porte.
 *
 * La forme `ec` est refusee en nommant ce qui manque plutot que rendue
 * comme une reussite : le depot a bien ECDSA, mais la demande de
 * signature n'est batie que pour RSA, et annoncer une courbe qu'on ne
 * signe pas donnerait un fichier qu'aucune autorite n'accepterait.
 *
 * Discrimine par `git stash push` sur les fichiers SUIVIS, le module de
 * demande etant un fichier neuf ecarte a la main : 8 des 10 cas tombent.
 * Les 2 autres sont nommes ici — « l'export d'un certificat signe
 * fonctionne toujours » est le TEMOIN de non-regression, la commande
 * existant deja, et « un nom inconnu est refuse a l'export » passait
 * avant pour la meme raison, le message n'ayant pas change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TftpServer } from '@/network/tftp/TftpSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

const GENERE = 'execute vpn certificate local generate rsa DEMANDE 1024 '
  + 'fgt.labo.local FR IDF Paris Labo Reseau admin@labo.local';

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const srv = new LinuxServer('linux-server', 'AC', -200, 0);
  new Cable('lan').connect(srv.getPort('eth0')!, fgt.getPort('port2')!);
  srv.configureInterface('eth0',
    new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
  new TftpServer(srv, {
    fs: new LinuxSftpFSAdapter(vfs, 1000, 1000), rootPath: '/srv/tftp',
  }).start();

  await taper(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);
  await fgt.executeCommand('execute ping 192.168.10.10');
  return { fgt, srv, vfs };
}

describe('execute vpn certificate local generate', () => {
  it('la demande porte le nom distingue compose des champs donnes', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand(GENERE)).not.toMatch(/Command fail|not available/i);
    const demande = fgt.getCertificateStore().request('DEMANDE');
    expect(demande?.subject).toBe(
      'C = FR, ST = IDF, L = Paris, O = Labo, OU = Reseau, '
      + 'CN = fgt.labo.local, emailAddress = admin@labo.local');
    expect(demande?.keySize).toBe(1024);
    expect(demande?.csrPem).toContain('-----BEGIN CERTIFICATE REQUEST-----');
  });

  it('la demande n\'est PAS un certificat local', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand(GENERE);

    expect(fgt.getCertificateStore().local('DEMANDE')).toBeUndefined();
    expect(fgt.getCertificateStore().requestNames()).toContain('DEMANDE');
  });

  it('l\'export TFTP envoie la demande sur le vrai serveur', async () => {
    const { fgt, vfs } = await laboratoire();
    await fgt.executeCommand(GENERE);

    expect(await fgt.executeCommand(
      'execute vpn certificate local export tftp DEMANDE demande.csr 192.168.10.10'))
      .not.toMatch(/Command fail/i);
    expect(vfs.readFile('/srv/tftp/demande.csr'))
      .toContain('-----BEGIN CERTIFICATE REQUEST-----');
  });

  it('une autorite SIGNE la demande exportee', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await fgt.executeCommand(GENERE);
    await fgt.executeCommand(
      'execute vpn certificate local export tftp DEMANDE demande.csr 192.168.10.10');

    await taper(srv, [
      'openssl genrsa -out /tmp/ca.key 1024',
      'openssl req -x509 -new -key /tmp/ca.key -subj "/CN=AC du labo" '
        + '-days 3650 -out /tmp/ca.crt',
    ]);
    await srv.executeCommand(
      `printf '%s' '${vfs.readFile('/srv/tftp/demande.csr') ?? ''}' > /tmp/demande.csr`);

    expect(await srv.executeCommand(
      'openssl x509 -req -in /tmp/demande.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key '
      + '-days 365 -out /tmp/signe.crt'))
      .toContain('Certificate request self-signature ok');
    expect(await srv.executeCommand('openssl x509 -in /tmp/signe.crt -noout -subject'))
      .toContain('CN = fgt.labo.local');
  });

  it('un nom hors du jeu autorise est refuse', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand(
      'execute vpn certificate local generate rsa MON.NOM 2048 x FR a b c d e'))
      .toContain('a certificate name holds only letters, digits');
    expect(fgt.getCertificateStore().requestNames()).toHaveLength(0);
  });

  it('une taille de cle hors des quatre admises est refusee', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand(
      'execute vpn certificate local generate rsa AUTRE 999 x FR a b c d e'))
      .toContain('a key size is one of 1024, 1536, 2048, 4096.');
    expect(fgt.getCertificateStore().requestNames()).toHaveLength(0);
  });

  it('un nom deja pris est refuse', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand(GENERE);

    expect(await fgt.executeCommand(
      'execute vpn certificate local generate rsa DEMANDE 1024 x FR a b c d e'))
      .toContain('certificate "DEMANDE" already exists.');
  });

  it('la forme `ec` nomme la brique absente', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand(
      'execute vpn certificate local generate ec X secp256r1 x FR a b c d e'))
      .toContain('this build generates RSA requests only.');
  });

  it('TEMOIN : l\'export d\'un certificat signe fonctionne toujours', async () => {
    const { fgt, vfs } = await laboratoire();

    expect(await fgt.executeCommand(
      'execute vpn certificate local export tftp Fortinet_CA_SSL usine.cer 192.168.10.10'))
      .not.toMatch(/Command fail/i);
    expect(vfs.readFile('/srv/tftp/usine.cer')).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('un nom inconnu est refuse a l\'export', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand(
      'execute vpn certificate local export tftp ZORGLUB x.cer 192.168.10.10'))
      .toContain('certificate "ZORGLUB" does not exist.');
  });
});
