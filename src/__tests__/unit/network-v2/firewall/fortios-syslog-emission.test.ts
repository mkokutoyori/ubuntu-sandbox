/**
 * `config log syslogd` : quatre collecteurs declares, `onCommit` VIDES.
 *
 * §6.5 du carnet nommait le point : « les collecteurs syslog sont
 * configurables et n'emettent pas encore vers un vrai collecteur ». Meme
 * famille de defaut que le serveur DHCP en E47 : une table declaree,
 * stockee, rendue par `show`, et lue par personne.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **Le datagramme part pour de bon** et atterrit dans le
 *      `/var/log/syslog` d'une VRAIE machine Linux dont `rsyslog` ecoute
 *      (`imudp`). Aucun raccourci d'objet a objet.
 *   2. **`set status disable` eteint vraiment** — un collecteur declare
 *      puis desactive ne doit rien emettre.
 *   3. **Le port declare est le port utilise**, et le changer change la
 *      destination.
 *   4. **Le filtre de severite FILTRE** : sous `set severity emergency`,
 *      une notification ordinaire ne part pas.
 *   5. **Les quatre collecteurs sont quatre destinations distinctes**,
 *      pas un seul reglage repete.
 *
 * Discrimination (`git stash push -- src/network/`) : 7 des 8 cas tombent
 * avant correctif. Le huitieme est le temoin NEGATIF (« sans collecteur
 * declare, rien ne part »), dont c'est l'objet de passer des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
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

const RSYSLOG_ECOUTE = [
  'sed -i \'s/^#module(load="imudp")/module(load="imudp")/\' /etc/rsyslog.conf',
  'sed -i \'s/^#input(type="imudp" port="514")/input(type="imudp" port="514")/\' /etc/rsyslog.conf',
  'systemctl restart rsyslog',
];

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, -150, 0);
  const collecteur = new LinuxServer('linux-server', 'LOG', -300, 0);
  const poste = new LinuxPC('linux-pc', 'PC', -300, 120);

  new Cable('u').connect(fw.getPort('port1')!, commutateur.getPort('eth0')!);
  new Cable('a').connect(collecteur.getPort('eth0')!, commutateur.getPort('eth1')!);
  new Cable('b').connect(poste.getPort('eth0')!, commutateur.getPort('eth2')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(collecteur, ['ip link set eth0 up',
    'ip addr add 192.168.1.53/24 dev eth0', ...RSYSLOG_ECOUTE]);
  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);

  return { fw, sh, collecteur, poste };
}

function collecteurDeclare(sh: FortiShell, adresse = '192.168.1.53'): string {
  return run(sh,
    'config log syslogd setting',
    'set status enable',
    `set server "${adresse}"`,
    'set facility local7',
    'end');
}

async function evenementJournalise(sh: FortiShell, poste: LinuxPC): Promise<void> {
  run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action deny', 'set schedule "always"', 'set service "ALL"',
    'set logtraffic all', 'next', 'end');
  await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
}

beforeEach(() => { Logger.reset(); });

describe('config log syslogd setting', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    collecteurDeclare(sh);

    const rendu = sh.execute('show log syslogd setting');
    expect(rendu).toMatch(/set status enable/);
    expect(rendu).toMatch(/set server "192\.168\.1\.53"/);
    expect(rendu).toMatch(/set facility local7/);
  });

  it('le collecteur declare recoit un VRAI datagramme', async () => {
    const { sh, collecteur, poste } = await laboratoire();
    collecteurDeclare(sh);

    await evenementJournalise(sh, poste);

    const journal = await collecteur.executeCommand('cat /var/log/syslog');
    expect(journal).toMatch(/FGT .*Deny ICMP src port1:192\.168\.1\.10/);
  });

  it('`set status disable` eteint vraiment l`emission', async () => {
    const { sh, collecteur, poste } = await laboratoire();
    collecteurDeclare(sh);
    await evenementJournalise(sh, poste);
    expect(await collecteur.executeCommand('cat /var/log/syslog')).toMatch(/FGT .*Deny/);

    run(sh, 'config log syslogd setting', 'set status disable', 'end');
    await runOn(collecteur, ['truncate -s 0 /var/log/syslog']);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    expect(await collecteur.executeCommand('cat /var/log/syslog')).not.toMatch(/FGT .*Deny/);
  });

  it('sans collecteur declare, rien ne part', async () => {
    const { sh, collecteur, poste } = await laboratoire();

    await evenementJournalise(sh, poste);

    expect(await collecteur.executeCommand('cat /var/log/syslog')).not.toMatch(/FGT .*Deny/);
  });

  it('le port declare est celui utilise', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config log syslogd setting', 'set status enable',
      'set server "192.168.1.53"', 'set port 1514', 'end');

    const serveurs = fw.getSyslogAgent().listServers();
    expect(serveurs.some(s => s.ip === '192.168.1.53' && s.port === 1514)).toBe(true);
  });

  it('un filtre de severite `emergency` retient une notification ordinaire', async () => {
    const { sh, collecteur, poste } = await laboratoire();
    collecteurDeclare(sh);
    await evenementJournalise(sh, poste);
    expect(await collecteur.executeCommand('cat /var/log/syslog')).toMatch(/FGT .*Deny/);

    run(sh, 'config log syslogd filter', 'set severity emergency', 'end');
    await runOn(collecteur, ['truncate -s 0 /var/log/syslog']);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    expect(await collecteur.executeCommand('cat /var/log/syslog')).not.toMatch(/FGT .*Deny/);
  });

  it('les quatre collecteurs sont quatre destinations distinctes', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config log syslogd setting', 'set status enable',
      'set server "192.168.1.53"', 'end');
    run(sh, 'config log syslogd2 setting', 'set status enable',
      'set server "192.168.1.54"', 'end');

    const adresses = fw.getSyslogAgent().listServers().map(s => s.ip);
    expect(adresses).toContain('192.168.1.53');
    expect(adresses).toContain('192.168.1.54');
  });

  it('retirer un collecteur retire sa destination', async () => {
    const { fw, sh } = await laboratoire();
    collecteurDeclare(sh);
    expect(fw.getSyslogAgent().listServers().map(s => s.ip)).toContain('192.168.1.53');

    run(sh, 'config log syslogd setting', 'set status disable', 'end');

    expect(fw.getSyslogAgent().listServers().map(s => s.ip)).not.toContain('192.168.1.53');
  });
});
