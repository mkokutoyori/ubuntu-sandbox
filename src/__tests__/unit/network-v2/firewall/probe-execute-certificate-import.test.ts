/**
 * Le certificat signe REVIENT sur le pare-feu, et il sert.
 *
 * Le lot precedent avait donne au pare-feu de quoi FABRIQUER une demande
 * de signature et de quoi l'EXPORTER ; il n'avait aucun moyen de
 * recuperer le certificat une fois signe. Le tour etait donc ouvert par
 * un bout et ferme par l'autre : l'apprenant produisait une demande, la
 * faisait signer, et devait ensuite coller le resultat par
 * `config vpn certificate local` — c'est-a-dire abandonner la cle privee
 * que le pare-feu avait gardee, puisque cette commande veut aussi la cle.
 *
 * `execute vpn certificate local import tftp <fichier> <ip> cer` la
 * ferme, et sa mecanique est celle d'une vraie machine : la commande ne
 * prend PAS de nom de certificat, parce que le nom vient de
 * l'APPARIEMENT — la cle publique du certificat importe est comparee a
 * celles des demandes en attente, et c'est la demande qui donne son nom
 * et sa cle privee. Un certificat qui n'apparie rien est refuse plutot
 * que range sous un nom invente.
 *
 * `execute vpn certificate ca import tftp` nomme ce qu'elle importe
 * `CA_Cert_1`, `CA_Cert_2`… — le nom atteste par la documentation de
 * Fortinet, celui qu'on retrouve ensuite dans `set ca CA_Cert_1`.
 *
 * **Le defaut trouve en le mesurant depasse l'import.** Un certificat que
 * le pare-feu tient dans son magasin n'existait pas pour la
 * CONFIGURATION : `set servercert "DEMANDE"` repondait « does not exist
 * in `vpn certificate local` », parce que le controle de reference lit le
 * magasin d'OBJETS FortiOS et qu'une commande `execute` n'y ecrivait
 * rien. Le certificat etait donc importe, complet, et inutilisable. Les
 * deux imports declarent desormais leur objet par le meme chemin que
 * l'amorcage des certificats d'usine, qui le faisait deja — une seule
 * ecriture, deux appelants.
 *
 * L'observable finale n'est pas un objet en memoire mais une poignee de
 * main : le portail SSL-VPN est arme avec le certificat importe, un poste
 * l'atteint en TLS, et `curl -v` montre que le certificat PRESENTE est
 * celui que l'autorite du laboratoire a signe. Une cle privee qui
 * n'appartiendrait pas a ce certificat ne passerait pas cette porte.
 *
 * Discrimine par `git stash push` : 12 des 13 cas tombent. Le seul qui
 * passe des deux cotes est le TEMOIN — l'export d'un certificat d'usine,
 * qui existait deja et devait continuer de fonctionner ; c'est lui qui
 * dit que le remaniement du chemin d'export n'a rien casse.
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

  await taper(srv, [
    'openssl genrsa -out /tmp/ca.key 1024',
    'openssl req -x509 -new -key /tmp/ca.key -subj "/CN=AC du labo" '
      + '-days 3650 -out /tmp/ca.crt',
  ]);
  return { fgt, srv, vfs };
}

async function signerLaDemande(
  fgt: FortiGate, srv: LinuxServer, vfs: VirtualFileSystem,
): Promise<void> {
  await fgt.executeCommand(GENERE);
  await fgt.executeCommand(
    'execute vpn certificate local export tftp DEMANDE demande.csr 192.168.10.10');
  await srv.executeCommand(
    `printf '%s' '${vfs.readFile('/srv/tftp/demande.csr') ?? ''}' > /tmp/demande.csr`);
  await srv.executeCommand(
    'openssl x509 -req -in /tmp/demande.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key '
    + '-days 365 -out /tmp/signe.crt');
  vfs.writeFile('/srv/tftp/signe.crt',
    await srv.executeCommand('cat /tmp/signe.crt'), 1000, 1000, 0o022);
  vfs.writeFile('/srv/tftp/ca.crt',
    await srv.executeCommand('cat /tmp/ca.crt'), 1000, 1000, 0o022);
}

describe('execute vpn certificate local import', () => {
  it('le certificat signe rejoint la demande qui l\'a produit', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);

    expect(await fgt.executeCommand(
      'execute vpn certificate local import tftp signe.crt 192.168.10.10 cer'))
      .not.toMatch(/Command fail/i);
    expect(fgt.getCertificateStore().local('DEMANDE')?.certificate.subject)
      .toContain('CN = fgt.labo.local');
  });

  it('la demande en attente disparait une fois signee', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);
    await fgt.executeCommand(
      'execute vpn certificate local import tftp signe.crt 192.168.10.10 cer');

    expect(fgt.getCertificateStore().requestNames()).not.toContain('DEMANDE');
  });

  it('la cle privee gardee est celle du certificat importe', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    const attendue = (await (async () => {
      await signerLaDemande(fgt, srv, vfs);
      return fgt.getCertificateStore().request('DEMANDE')?.privateKeyPem;
    })())!;
    await fgt.executeCommand(
      'execute vpn certificate local import tftp signe.crt 192.168.10.10 cer');

    expect(fgt.getCertificateStore().local('DEMANDE')?.privateKeyPem).toBe(attendue);
  });

  it('le certificat importe devient un OBJET de la configuration', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);
    await fgt.executeCommand(
      'execute vpn certificate local import tftp signe.crt 192.168.10.10 cer');

    expect(await fgt.executeCommand('show vpn certificate local DEMANDE'))
      .toContain('edit "DEMANDE"');
  });

  it('le portail SSL-VPN sert le certificat importe en TLS', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);
    await fgt.executeCommand(
      'execute vpn certificate local import tftp signe.crt 192.168.10.10 cer');

    await taper(fgt, [
      'config vpn ssl settings', 'set status enable',
      'set servercert "DEMANDE"', 'set source-interface "port2"', 'end',
    ]);
    expect(fgt.getSslVpnPortal().isListening()).toBe(true);

    const trace = await srv.executeCommand('curl -vk https://192.168.10.1:10443/');
    expect(trace).toContain('CN = fgt.labo.local');
    expect(await srv.executeCommand('curl -sk https://192.168.10.1:10443/'))
      .toContain('SSL-VPN');
  });

  it('un certificat qui n\'apparie aucune demande est refuse', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);

    expect(await fgt.executeCommand(
      'execute vpn certificate local import tftp ca.crt 192.168.10.10 cer'))
      .toContain('no pending certificate request matches this certificate.');
  });

  it('le format p12 nomme la brique absente', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand(
      'execute vpn certificate local import tftp x.p12 192.168.10.10 p12'))
      .toContain('this build has no PKCS#12 reader');
  });

  it('un fichier absent du serveur est refuse', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand(
      'execute vpn certificate local import tftp absent.crt 192.168.10.10 cer'))
      .toMatch(/did not give "absent.crt"/);
  });
});

describe('execute vpn certificate ca', () => {
  it('l\'autorite importee prend le nom atteste `CA_Cert_1`', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);

    expect(await fgt.executeCommand(
      'execute vpn certificate ca import tftp ca.crt 192.168.10.10'))
      .not.toMatch(/Command fail/i);
    expect(fgt.getCertificateStore().authority('CA_Cert_1')?.certificate.subject)
      .toContain('AC du labo');
  });

  it('une seconde autorite prend le nom suivant', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);
    await fgt.executeCommand('execute vpn certificate ca import tftp ca.crt 192.168.10.10');
    await fgt.executeCommand('execute vpn certificate ca import tftp ca.crt 192.168.10.10');

    expect(fgt.getCertificateStore().authority('CA_Cert_2')).toBeDefined();
  });

  it('l\'autorite importee devient un OBJET de la configuration', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);
    await fgt.executeCommand('execute vpn certificate ca import tftp ca.crt 192.168.10.10');

    expect(await fgt.executeCommand('show vpn certificate ca CA_Cert_1'))
      .toContain('edit "CA_Cert_1"');
  });

  it('`ca export` renvoie l\'autorite sur le serveur', async () => {
    const { fgt, srv, vfs } = await laboratoire();
    await signerLaDemande(fgt, srv, vfs);
    await fgt.executeCommand('execute vpn certificate ca import tftp ca.crt 192.168.10.10');

    expect(await fgt.executeCommand(
      'execute vpn certificate ca export tftp CA_Cert_1 sortie.crt 192.168.10.10'))
      .not.toMatch(/Command fail/i);
    expect(vfs.readFile('/srv/tftp/sortie.crt')).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('TEMOIN : l\'export d\'un certificat local d\'usine fonctionne toujours', async () => {
    const { fgt, vfs } = await laboratoire();

    expect(await fgt.executeCommand(
      'execute vpn certificate local export tftp Fortinet_CA_SSL usine.cer 192.168.10.10'))
      .not.toMatch(/Command fail/i);
    expect(vfs.readFile('/srv/tftp/usine.cer')).toContain('-----BEGIN CERTIFICATE-----');
  });
});
