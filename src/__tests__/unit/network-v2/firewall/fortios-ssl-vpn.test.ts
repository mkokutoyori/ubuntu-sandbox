/**
 * SSL-VPN en mode web : le portail ECOUTE, et il presente un certificat.
 *
 * `config vpn ssl settings` n'avait aucun schema, donc toute la famille
 * tombait dans le vide — un apprenant qui suit un tutoriel FortiGate
 * s'arrete a la premiere ligne. La matiere, elle, etait la : le pare-feu
 * porte une pile TCP, un serveur HTTP/1.1 reel (le portail
 * d'authentification de la phase 7), un serveur TLS reel, et depuis le
 * chantier des certificats un magasin ou `set servercert` peut puiser.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **`set status enable` OUVRE un port** — 10443 par defaut — et
 *      `disable` le ferme. Un reglage qui n'ouvre rien serait un decor.
 *   2. **`set servercert` decide du certificat presente.** Sans lui, ou
 *      avec un nom inconnu, le portail ne peut pas servir en TLS et la
 *      commande est refusee plutot que rangee.
 *   3. **`authentication-rule` decide QUI entre** : un utilisateur d'un
 *      groupe nomme par une regle est admis, un autre est refuse.
 *   4. **`tunnel-mode` est REFUSE en nommant la brique absente** : il
 *      faudrait un client (FortiClient) qui n'existe pas dans ce
 *      simulateur, et l'accepter promettrait un tunnel que personne ne
 *      peut monter.
 *
 * Defaut trouve en la mesurant, et il depasse le SSL-VPN : **un pare-feu
 * ne remettait AUCUN segment TCP a sa propre pile**, si bien que tout
 * ecouteur qu'il porte etait sourd — le portail d'authentification de la
 * phase 7 compris, dont aucun test n'avait jamais joint le port depuis le
 * fil.
 *
 * Discriminee par `git stash push -- src/network/` : 12 des 13 cas
 * tombent avant correctif. Le seul qui passe des deux cotes est « un
 * certificat inconnu est refuse », parce que `set servercert` n'existait
 * pas du tout.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem, privateKeyToPem } from '@/network/pki/pem';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function flat(pem: string): string {
  return pem.replace(/\s+/g, ' ').trim();
}

const NOW = Date.UTC(2026, 0, 1);
const PORTAL_IP = '192.168.1.1';

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const autorite = CertificateAuthority.generate('CN = Labo VPN', { now: NOW - 86_400_000 });
  const issued = autorite.issueCertificate({
    subject: 'CN = portail.labo',
    notBefore: NOW - 3600_000,
    notAfter: NOW + 365 * 24 * 3600_000,
  });

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => NOW });
  const sh = new FortiShell(fw);
  const poste = new LinuxPC('linux-pc', 'POSTE', 100, 0);
  new Cable('lan').connect(poste.getPort('eth0')!, fw.getPort('port1')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    `set ip ${PORTAL_IP} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
    'config vpn certificate local',
    'edit "PORTAIL"',
    `set certificate "${flat(certToPem(issued.cert))}"`,
    `set private-key "${flat(privateKeyToPem(issued.privateKey))}"`,
    'next', 'end',
    'config user local',
    'edit "alice"', 'set type password', 'set passwd "MotDePasse1"', 'next',
    'edit "bob"', 'set type password', 'set passwd "MotDePasse2"', 'next', 'end',
    'config user group',
    'edit "vpn-users"', 'set member "alice"', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);

  return { fw, sh, poste, autorite };
}

function activerPortail(sh: FortiShell, ...extra: string[]): string {
  return run(sh,
    'config vpn ssl settings',
    'set status enable',
    'set servercert "PORTAIL"',
    'set source-interface "port1"',
    ...extra,
    'config authentication-rule',
    'edit 1', 'set groups "vpn-users"', 'set portal "full-access"', 'next', 'end',
    'end');
}

beforeEach(() => { Logger.reset(); });

describe('config vpn ssl settings', () => {
  it('`set status enable` ouvre le port 10443', async () => {
    const { fw, sh } = await laboratoire();

    activerPortail(sh);

    expect(fw.getSslVpnPortal().isListening()).toBe(true);
    expect(fw.getSslVpnPortal().port()).toBe(10443);
  });

  it('`set port` deplace le portail', async () => {
    const { fw, sh } = await laboratoire();

    activerPortail(sh, 'set port 8443');

    expect(fw.getSslVpnPortal().port()).toBe(8443);
  });

  it('`set status disable` referme le port', async () => {
    const { fw, sh } = await laboratoire();
    activerPortail(sh);

    run(sh, 'config vpn ssl settings', 'set status disable', 'end');

    expect(fw.getSslVpnPortal().isListening()).toBe(false);
  });

  it('sans certificat, le portail est refuse plutot qu`ouvert en clair', async () => {
    const { fw, sh } = await laboratoire();

    const sortie = run(sh,
      'config vpn ssl settings', 'set status enable', 'end');

    expect(sortie).toMatch(/Command fail/);
    expect(fw.getSslVpnPortal().isListening()).toBe(false);
  });

  it('un certificat inconnu est refuse', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh,
      'config vpn ssl settings', 'set servercert "PAS_LA"');

    expect(sortie).toMatch(/entry not found|Command fail/);
    run(sh, 'abort');
  });

  it('la configuration rendue reproduit ce qui a ete tape', async () => {
    const { sh } = await laboratoire();
    activerPortail(sh, 'set port 8443');

    const rendu = sh.execute('show vpn ssl settings');
    expect(rendu).toMatch(/set status enable/);
    expect(rendu).toMatch(/set servercert "PORTAIL"/);
    expect(rendu).toMatch(/set port 8443/);
    expect(rendu).toMatch(/edit 1/);
    expect(rendu).toMatch(/set groups "vpn-users"/);
  });
});

describe('le portail sert vraiment', () => {
  it('un client TLS obtient la page du portail', async () => {
    const { sh, poste } = await laboratoire();
    activerPortail(sh);

    const sortie = await poste.executeCommand(`curl -sk https://${PORTAL_IP}:10443/`);

    expect(sortie).toMatch(/[Ll]ogin|SSL-VPN|portal/);
  });

  it('le certificat presente est celui qui a ete configure', async () => {
    const { sh, poste } = await laboratoire();
    activerPortail(sh);

    const trace = await poste.executeCommand(`curl -vk https://${PORTAL_IP}:10443/`);

    expect(trace).toContain('portail.labo');
  });

  it('un membre d`un groupe nomme par une regle est admis', async () => {
    const { fw, sh } = await laboratoire();
    activerPortail(sh);

    const verdict = await fw.getSslVpnPortal()
      .authenticate('192.168.1.10', { username: 'alice', password: 'MotDePasse1' });

    expect(verdict.ok).toBe(true);
  });

  it('un utilisateur qu`aucune regle ne nomme est refuse', async () => {
    const { fw, sh } = await laboratoire();
    activerPortail(sh);

    const verdict = await fw.getSslVpnPortal()
      .authenticate('192.168.1.10', { username: 'bob', password: 'MotDePasse2' });

    expect(verdict.ok).toBe(false);
  });

  it('un mot de passe faux est refuse', async () => {
    const { fw, sh } = await laboratoire();
    activerPortail(sh);

    const verdict = await fw.getSslVpnPortal()
      .authenticate('192.168.1.10', { username: 'alice', password: 'PasCelui-La' });

    expect(verdict.ok).toBe(false);
  });
});

describe('config vpn ssl web portal', () => {
  it('un portail se declare et `show` le rend', async () => {
    const { sh } = await laboratoire();

    run(sh,
      'config vpn ssl web portal',
      'edit "full-access"', 'set web-mode enable', 'next', 'end');

    expect(sh.execute('show vpn ssl web portal')).toMatch(/edit "full-access"/);
  });

  it('`tunnel-mode` est refuse en nommant la brique absente', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh,
      'config vpn ssl web portal',
      'edit "full-access"', 'set tunnel-mode enable');

    expect(sortie).toMatch(/Command fail/);
    expect(sortie).toMatch(/FortiClient/);
    run(sh, 'abort');
  });
});
