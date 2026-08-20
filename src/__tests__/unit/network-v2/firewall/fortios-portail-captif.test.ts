/**
 * Le portail captif CAPTURE.
 *
 * §6.8 du carnet nommait le point : le portail servait le formulaire et
 * traitait le POST, mais rien n'INTERCEPTAIT le premier flux HTTP pour y
 * rediriger — le laboratoire s'authentifiait en APPELANT le portail, pas
 * en etant detourne vers lui. Un portail captif qui ne capture pas est
 * un decor : la fonction a un nom, une configuration et une vue, et le
 * mecanisme qu'elle promet n'a pas lieu.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait, verifie contre
 * la documentation Fortinet :
 *
 *   1. **Le detournement est une VRAIE reponse HTTP sur une VRAIE
 *      connexion TCP** — 303, en-tete `Location`, vers
 *      `http://<pare-feu>:1000/fgtauth`. Le client est un `LinuxPC` du
 *      depot qui tape `curl` ; aucun raccourci d'objet a objet.
 *   2. **Le port vient de `config system global`** (`auth-http-port`,
 *      1000 par defaut) et le changer change la redirection.
 *   3. **Une fois authentifie, on n'est PLUS detourne** : le meme `curl`
 *      atteint le vrai serveur. Sans cela, le portail serait une
 *      souriciere.
 *   4. **Ce qui n'est pas du HTTP n'est pas detourne mais REFUSE** : on
 *      ne peut rediriger un ping vers un formulaire, et pretendre le
 *      contraire serait pire que le refus.
 *   5. **Sans exigence d'authentification, rien n'est detourne.**
 *
 * Discrimination (`git stash push -- src/network/`) : 6 des 9 cas tombent
 * avant correctif. Les 3 autres sont nommes ici plutot que laisses a
 * decouvrir — le cas « une fois authentifie » est un TEMOIN de non
 * regression (le flux passait deja), et les deux autres sont les temoins
 * NEGATIFS (« sans exigence d'authentification » et le ping refuse),
 * dont c'est l'objet de passer des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  const serveur = new LinuxServer('linux-server', 'WEB', 150, 0);

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(serveur.getPort('eth0')!, fw.getPort('port2')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(serveur, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1',
    'systemctl start nginx']);

  run(sh, 'config user local', 'edit "alice"',
    'set type password', 'set passwd "Secret123"', 'next', 'end');
  run(sh, 'config user group', 'edit "employes"',
    'set member "alice"', 'next', 'end');

  return { fw, sh, poste, serveur };
}

function politiqueAuthentifiee(sh: FortiShell): string {
  return run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set groups "employes"',
    'next', 'end');
}

function politiqueLibre(sh: FortiShell): string {
  return run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('portail captif — le detournement', () => {
  it('un flux HTTP non authentifie recoit un 303 vers le portail', async () => {
    const { sh, poste } = await laboratoire();
    politiqueAuthentifiee(sh);

    const sortie = await poste.executeCommand('curl -v http://203.0.113.10/');

    expect(sortie).toMatch(/303/);
    expect(sortie).toMatch(/[Ll]ocation:\s*http:\/\/192\.168\.1\.1:1000\/fgtauth/);
  });

  it('le port de redirection vient de `config system global`', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system global', 'set auth-http-port 8010', 'end');
    politiqueAuthentifiee(sh);

    const sortie = await poste.executeCommand('curl -v http://203.0.113.10/');

    expect(sortie).toMatch(/[Ll]ocation:\s*http:\/\/192\.168\.1\.1:8010\/fgtauth/);
  });

  it('une fois authentifie, le meme flux atteint le vrai serveur', async () => {
    const { fw, sh, poste } = await laboratoire();
    politiqueAuthentifiee(sh);
    fw.getIdentityTable().bind({
      address: '192.168.1.10', user: 'alice', source: 'firewall',
      groups: ['employes'], timeoutSec: 300,
    });

    const sortie = await poste.executeCommand('curl -sS http://203.0.113.10/');

    expect(sortie).not.toMatch(/fgtauth/);
    expect(sortie).toMatch(/<html|Welcome|nginx/i);
  });

  it('sans exigence d`authentification, rien n`est detourne', async () => {
    const { sh, poste } = await laboratoire();
    politiqueLibre(sh);

    const sortie = await poste.executeCommand('curl -sS http://203.0.113.10/');

    expect(sortie).not.toMatch(/fgtauth/);
  });

  it('un ping non authentifie est REFUSE, pas detourne', async () => {
    const { sh, poste } = await laboratoire();
    politiqueAuthentifiee(sh);

    expect(await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10'))
      .toMatch(/, 100% packet loss/);
  });

  it('le portail annonce la page d`authentification a l`adresse redirigee', async () => {
    const { sh, poste } = await laboratoire();
    politiqueAuthentifiee(sh);

    const sortie = await poste.executeCommand('curl -sS http://192.168.1.1:1000/fgtauth');

    expect(sortie).toMatch(/<form|username|Authentication/i);
  });
});

describe('security-mode captive-portal sur une interface', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config system interface', 'edit "port1"',
      'set security-mode captive-portal', 'next', 'end');

    expect(sh.execute('show system interface'))
      .toMatch(/set security-mode captive-portal/);
  });

  it('elle detourne meme sans `set groups` sur la politique', async () => {
    const { sh, poste } = await laboratoire();
    politiqueLibre(sh);
    run(sh, 'config system interface', 'edit "port1"',
      'set security-mode captive-portal', 'next', 'end');

    const sortie = await poste.executeCommand('curl -v http://203.0.113.10/');

    expect(sortie).toMatch(/[Ll]ocation:\s*http:\/\/192\.168\.1\.1:1000\/fgtauth/);
  });

  it('`set security-mode none` la retire vraiment', async () => {
    const { sh, poste } = await laboratoire();
    politiqueLibre(sh);
    run(sh, 'config system interface', 'edit "port1"',
      'set security-mode captive-portal', 'next', 'end');
    expect(await poste.executeCommand('curl -v http://203.0.113.10/'))
      .toMatch(/fgtauth/);

    run(sh, 'config system interface', 'edit "port1"',
      'set security-mode none', 'next', 'end');

    const sortie = await poste.executeCommand('curl -sS http://203.0.113.10/');
    expect(sortie).not.toMatch(/fgtauth/);
    expect(sortie).toMatch(/<html|Welcome|nginx/i);
  });
});
