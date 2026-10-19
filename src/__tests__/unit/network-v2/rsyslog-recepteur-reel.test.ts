/**
 * rsyslog en RECEPTEUR (`docs/PRD-Rsyslog.md`).
 *
 * Mesure de depart, faite en cablant un routeur Cisco a un serveur
 * Linux : `which rsyslogd` repond, `systemctl status rsyslog` dit
 * `active (running)`, `/var/log/syslog` se remplit — et
 * `/etc/rsyslog.conf` N'EXISTE PAS, `/etc/rsyslog.d/` non plus, rien
 * n'ecoute sur 514. Pendant ce temps `show logging` sur le routeur
 * comptait ses messages comme partis. De VRAIS datagrammes partaient sur
 * le fil et personne ne les recevait : la centralisation, qui est le
 * sujet meme d'un cours syslog, n'avait aucun support.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

function serveur(): LinuxServer {
  const s = new LinuxServer('linux-server', 'collecteur', 0, 0);
  s.powerOn();
  return s;
}

async function activerImudp(s: LinuxServer): Promise<void> {
  await s.executeCommand("sed -i 's/^#module(load=\"imudp\")/module(load=\"imudp\")/' /etc/rsyslog.conf");
  await s.executeCommand("sed -i 's/^#input(type=\"imudp\" port=\"514\")/input(type=\"imudp\" port=\"514\")/' /etc/rsyslog.conf");
  await s.executeCommand('systemctl restart rsyslog');
}

async function laboratoire(): Promise<{ collector: LinuxServer; sender: LinuxServer }> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const collector = serveur();
  const sender = new LinuxServer('linux-server', 'emetteur', 0, 0);
  [collector, sender].forEach((d, i) => { new Cable(`l${i}`).connect(d.getPorts()[0], sw.getPorts()[i]); });
  collector.getPorts()[0].configureIP(new IPAddress('10.0.12.100'), new SubnetMask('255.255.255.0'));
  sender.getPorts()[0].configureIP(new IPAddress('10.0.12.1'), new SubnetMask('255.255.255.0'));
  [sender, sw].forEach((d) => d.powerOn());
  await activerImudp(collector);
  return { collector, sender };
}

function envoyer(sender: LinuxServer, charge: string): void {
  expect(sender.sendUdpDatagram(new IPAddress('10.0.12.100'), 514, 40514, charge)).toBe(true);
}

describe('les fichiers de Debian sont la, et le service les lit', () => {
  it('`/etc/rsyslog.conf` et `/etc/rsyslog.d/` existent', async () => {
    const s = serveur();
    expect(await s.executeCommand('ls /etc/rsyslog.conf')).not.toContain('No such file');
    expect(await s.executeCommand('ls /etc/rsyslog.d/')).toContain('50-default.conf');
  }, 30_000);

  it('a l\'installation, RIEN n\'ecoute sur 514', async () => {
    const s = serveur();
    expect(await s.executeCommand('grep "^#module(load=\\"imudp\\")" /etc/rsyslog.conf')).toContain('imudp');
    expect(await s.executeCommand('ss -ulnp | grep 514')).toBe('');
  }, 30_000);

  it('decommenter `imudp` et redemarrer OUVRE vraiment le port', async () => {
    const s = serveur();
    await activerImudp(s);
    expect(await s.executeCommand('ss -ulnp | grep 514')).toContain('514');
  }, 30_000);

  it('`systemctl stop` referme le port', async () => {
    const s = serveur();
    await activerImudp(s);
    await s.executeCommand('systemctl stop rsyslog');
    expect(await s.executeCommand('ss -ulnp | grep 514')).toBe('');
  }, 30_000);
});

describe('l\'etat du service suit l\'etat des fichiers', () => {
  it('`rsyslogd -N1` valide une configuration saine', async () => {
    const s = serveur();
    const out = await s.executeCommand('rsyslogd -N1');
    expect(out).toContain('config validation run (level 1)');
    expect(out).toContain('End of config validation run. Bye.');
  }, 30_000);

  it('`rsyslogd -N1` REFUSE une severite qui n\'existe pas', async () => {
    const s = serveur();
    await s.executeCommand("printf 'local7.pasunniveau\\t/var/log/x.log\\n' > /etc/rsyslog.d/99-bad.conf");
    expect(await s.executeCommand('rsyslogd -N1')).toContain('unknown priority name "pasunniveau"');
  }, 30_000);

  it('une regle fautive est signalee et ignoree, le service demarre (rsyslogd.c : hadErrMsgs)', async () => {
    const s = serveur();
    await s.executeCommand("printf 'local7.pasunniveau\\t/var/log/x.log\\n' > /etc/rsyslog.d/99-bad.conf");
    await s.executeCommand('systemctl restart rsyslog');
    expect((await s.executeCommand('systemctl is-active rsyslog')).trim()).toBe('active');
    expect(await s.executeCommand('grep "unknown priority name" /var/log/syslog')).toContain('"pasunniveau"');
  }, 30_000);

  it('un `/etc/rsyslog.conf` SUPPRIME nomme le fichier manquant', async () => {
    const s = serveur();
    await s.executeCommand('rm /etc/rsyslog.conf');
    const out = await s.executeCommand('systemctl restart rsyslog');
    expect(out).toContain('/etc/rsyslog.conf');
    expect(out).toContain('No such file or directory');
  }, 30_000);

  it('un `/etc/rsyslog.conf` VIDE n\'a aucune action : rsyslogd refuse de tourner (RS_RET_NO_ACTIONS)', async () => {
    const s = serveur();
    await s.executeCommand('> /etc/rsyslog.conf');
    const out = await s.executeCommand('systemctl restart rsyslog');
    expect(out).toContain('there are no active actions configured');
    expect(out).toContain('run failed with error -2103');
    expect((await s.executeCommand('systemctl is-active rsyslog')).trim()).toBe('failed');
  }, 30_000);
});

describe('un routeur Cisco envoie, le collecteur Linux recoit', () => {
  it('le message traverse le fil et atterrit dans le bon fichier', async () => {
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    const srv = serveur();
    const r = new CiscoRouter('R1', 0, 0);
    [srv, r].forEach((d, i) => { const c = new Cable(`c${i}`); c.connect(d.getPorts()[0], sw.getPorts()[i]); });
    srv.getPorts()[0].configureIP(new IPAddress('192.168.100.50'), new SubnetMask('255.255.255.0'));
    [r, sw].forEach((d) => d.powerOn());

    await activerImudp(srv);
    expect(await srv.executeCommand('ss -ulnp | grep 514'), 'le collecteur doit ecouter').toContain('514');

    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
      'logging host 192.168.100.50', 'logging trap informational',
      'logging facility local7', 'hostname R1-PROD', 'end']) {
      await r.executeCommand(c);
    }
    await new Promise((x) => setTimeout(x, 60));

    expect(await r.executeCommand('show logging')).toContain('192.168.100.50');

    const recu = await srv.executeCommand('grep CONFIG_I /var/log/syslog');
    expect(recu, 'le collecteur doit avoir recu').toContain('%SYS-5-CONFIG_I');
    expect(recu, 'sous le nom que l\'emetteur s\'est donne').toContain('R1-PROD');
  }, 60_000);

  it('le collecteur garde l\'horodatage et le nom portes par le message', async () => {
    const { collector, sender } = await laboratoire();
    envoyer(sender, '<190>Jan  1 00:00:00 VIEUX-NOM TEST: corps du message');
    const ligne = await collector.executeCommand('grep VIEUX-NOM /var/log/syslog');
    expect(ligne).toContain('VIEUX-NOM');
    expect(ligne).toContain('TEST: corps du message');
    expect(ligne, '%TIMESTAMP% est %timereported%').toContain('Jan  1 00:00:00');
    expect(ligne, 'l\'adresse source est %FROMHOST-IP%, absent du gabarit').not.toContain('10.0.12.1');
  }, 30_000);

  it('un message SANS en-tete exploitable prend l\'heure et la source du collecteur', async () => {
    const { collector, sender } = await laboratoire();
    envoyer(sender, '<190>TEST: sans en-tete');
    const ligne = await collector.executeCommand('grep "sans en-tete" /var/log/syslog');
    expect(ligne).toContain('10.0.12.1');
    expect(ligne).toMatch(/^[A-Z][a-z]{2}\s+\d{1,2}\s\d{2}:\d{2}:\d{2}\s/m);
  }, 30_000);

  it('un message SANS `<PRI>` n\'est pas jete', async () => {
    const { collector, sender } = await laboratoire();
    envoyer(sender, 'message sans priorite');
    expect(await collector.executeCommand('grep "sans priorite" /var/log/syslog')).toContain('message sans priorite');
  }, 30_000);

  it('un modele `?` dedie ecrit un fichier par equipement', async () => {
    const { collector, sender } = await laboratoire();
    await collector.executeCommand(
      "printf 'template(name=\"PerHost\" type=\"string\" string=\"/var/log/network/%%FROMHOST-IP%%.log\")\\nlocal7.* ?PerHost\\n' > /etc/rsyslog.d/10-network.conf",
    );
    await collector.executeCommand('systemctl restart rsyslog');
    envoyer(sender, '<189>Aug 11 05:00:00 R1 OSPF: adjacence');
    expect(await collector.executeCommand('cat /var/log/network/10.0.12.1.log')).toContain('adjacence');
  }, 30_000);
});
