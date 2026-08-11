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
import { analyserRsyslog, regleRetient } from '@/network/devices/linux/syslog/RsyslogConfig';

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

// ── L'analyseur ─────────────────────────────────────────────────────

describe('analyseur rsyslog', () => {
  it('un `input` sans `module` chargé n\'ouvre RIEN', () => {
    // Un vrai rsyslog ne fait rien d'un `input` dont le module n'est pas
    // charge ; l'accepter ferait ecouter une machine dont la
    // configuration ne le demande pas.
    expect(analyserRsyslog('input(type="imudp" port="514")').ecoutes).toHaveLength(0);
    expect(analyserRsyslog(
      'module(load="imudp")\ninput(type="imudp" port="514")',
    ).ecoutes).toEqual([{ protocole: 'udp', port: 514 }]);
  });

  it('la forme historique `$ModLoad` / `$UDPServerRun` est lue aussi', () => {
    const c = analyserRsyslog('$ModLoad imudp\n$UDPServerRun 514');
    expect(c.ecoutes).toEqual([{ protocole: 'udp', port: 514 }]);
  });

  it('une regle nomme son fichier, un renvoi son transport', () => {
    const c = analyserRsyslog('local7.*\t/var/log/net.log\n*.err @@10.0.0.1:514\n*.* @10.0.0.2');
    expect(c.regles[0].fichier).toBe('/var/log/net.log');
    expect(c.regles[1].renvoi).toEqual({ hote: '10.0.0.1', port: 514, tcp: true });
    expect(c.regles[2].renvoi).toEqual({ hote: '10.0.0.2', port: 514, tcp: false });
  });

  /**
   * Les severites vont a l'envers de l'intuition : 0 est le plus grave.
   * `.info` veut donc dire « info ET PLUS GRAVE ».
   */
  it('`.info` retient info ET plus grave, pas seulement info', () => {
    const r = analyserRsyslog('local7.info\t/var/log/x.log').regles[0];
    expect(regleRetient(r, 'local7', 6), 'info').toBe(true);
    expect(regleRetient(r, 'local7', 3), 'err est plus grave').toBe(true);
    expect(regleRetient(r, 'local7', 7), 'debug est moins grave').toBe(false);
    expect(regleRetient(r, 'auth', 6), 'autre facilite').toBe(false);
  });

  /**
   * `.none` EXCLUT — c'est ce qui fait fonctionner la ligne de Debian
   * `*.*;auth,authpriv.none`. Sans elle `/var/log/syslog` doublerait
   * `auth.log` et un mot de passe refuse serait dans deux fichiers.
   */
  it('`.none` exclut, et c\'est ce qui separe syslog de auth.log', () => {
    const r = analyserRsyslog('*.*;auth,authpriv.none\t-/var/log/syslog').regles[0];
    expect(regleRetient(r, 'local7', 6)).toBe(true);
    expect(regleRetient(r, 'auth', 6), 'auth doit etre EXCLU').toBe(false);
    expect(regleRetient(r, 'authpriv', 3)).toBe(false);
  });

  it('`=info` retient EXACTEMENT info', () => {
    const r = analyserRsyslog('local7.=info\t/var/log/x.log').regles[0];
    expect(regleRetient(r, 'local7', 6)).toBe(true);
    expect(regleRetient(r, 'local7', 3)).toBe(false);
  });
});

// ── Les fichiers et le service ──────────────────────────────────────

describe('les fichiers de Debian sont la, et le service les lit', () => {
  it('`/etc/rsyslog.conf` et `/etc/rsyslog.d/` existent', async () => {
    const s = serveur();
    expect(await s.executeCommand('ls /etc/rsyslog.conf')).not.toContain('No such file');
    expect(await s.executeCommand('ls /etc/rsyslog.d/')).toContain('50-default.conf');
  }, 30_000);

  /**
   * Un rsyslog fraichement installe n'ecoute PAS. Les modules sont
   * commentes, comme sur une vraie machine : les decommenter EST
   * l'exercice, et livrer un fichier deja actif le supprimerait.
   */
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

// ── La coherence service / configuration ────────────────────────────

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

  /**
   * Le point que demandait la commande : une unite ne doit pas se
   * declarer `active` derriere un demon qui n'a rien pu lire.
   */
  it('une configuration fautive fait ECHOUER le service', async () => {
    const s = serveur();
    await s.executeCommand("printf 'local7.pasunniveau\\t/var/log/x.log\\n' > /etc/rsyslog.d/99-bad.conf");
    const out = await s.executeCommand('systemctl restart rsyslog');
    expect(out).toContain('unknown priority name');
    expect((await s.executeCommand('systemctl is-active rsyslog')).trim()).toBe('failed');
  }, 30_000);

  it('un `/etc/rsyslog.conf` SUPPRIME nomme le fichier manquant', async () => {
    const s = serveur();
    await s.executeCommand('rm /etc/rsyslog.conf');
    const out = await s.executeCommand('systemctl restart rsyslog');
    expect(out).toContain('/etc/rsyslog.conf');
    expect(out).toContain('No such file or directory');
  }, 30_000);

  /**
   * Un fichier VIDE est legal — le demon demarre sans regle et n'ecrit
   * nulle part. C'est une panne differente et bien reelle : les logs
   * disparaissent sans que rien n'echoue.
   */
  it('un `/etc/rsyslog.conf` VIDE demarre — et n\'ecrit nulle part', async () => {
    const s = serveur();
    await s.executeCommand('> /etc/rsyslog.conf');
    await s.executeCommand('systemctl restart rsyslog');
    expect((await s.executeCommand('systemctl is-active rsyslog')).trim()).toBe('active');
    expect(await s.executeCommand('ss -ulnp | grep 514')).toBe('');
  }, 30_000);
});

// ── Le laboratoire de bout en bout ──────────────────────────────────

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

    // Le routeur affirme avoir emis — sans quoi une reception vide ne
    // distinguerait pas un collecteur sourd d'un emetteur muet.
    expect(await r.executeCommand('show logging')).toContain('192.168.100.50');

    const recu = await srv.executeCommand('grep CONFIG_I /var/log/syslog');
    expect(recu, 'le collecteur doit avoir recu').toContain('%SYS-5-CONFIG_I');
    expect(recu, 'sous le nom que l\'emetteur s\'est donne').toContain('R1-PROD');
  }, 60_000);

  /**
   * `RSYSLOG_TraditionalFileFormat` — le gabarit par defaut de Debian —
   * s'ecrit `%TIMESTAMP% %HOSTNAME% %syslogtag%%msg%`, et `%TIMESTAMP%`
   * est un alias de `%timereported%`, l'heure PORTEE PAR LE MESSAGE.
   * Le collecteur conserve donc l'heure et le nom de l'emetteur ; ses
   * propres valeurs sont `%timegenerated%` et `%FROMHOST-IP%`, deux
   * autres champs, que ce gabarit n'utilise pas.
   */
  it('le collecteur garde l\'horodatage et le nom portes par le message', async () => {
    const s = serveur();
    await activerImudp(s);
    const svc = (s as unknown as { executor: { rsyslogService: {
      recevoir(ip: string, c: string): void } } }).executor.rsyslogService;
    svc.recevoir('10.9.9.9', '<190>Jan  1 00:00:00 VIEUX-NOM TEST: corps du message');
    const ligne = await s.executeCommand('grep VIEUX-NOM /var/log/syslog');
    expect(ligne).toContain('VIEUX-NOM');
    expect(ligne).toContain('TEST: corps du message');
    expect(ligne, '%TIMESTAMP% est %timereported%').toContain('Jan  1 00:00:00');
    expect(ligne, 'l\'adresse source est %FROMHOST-IP%, absent du gabarit')
      .not.toContain('10.9.9.9');
  }, 30_000);

  it('un message SANS en-tete exploitable prend l\'heure et la source du collecteur', async () => {
    const s = serveur();
    await activerImudp(s);
    const svc = (s as unknown as { executor: { rsyslogService: {
      recevoir(ip: string, c: string): void } } }).executor.rsyslogService;
    svc.recevoir('10.9.9.7', '<190>TEST: sans en-tete');
    const ligne = await s.executeCommand('grep "sans en-tete" /var/log/syslog');
    expect(ligne).toContain('10.9.9.7');
    expect(ligne).toMatch(/^[A-Z][a-z]{2}\s+\d{1,2}\s\d{2}:\d{2}:\d{2}\s/m);
  }, 30_000);

  it('un message SANS `<PRI>` n\'est pas jete', async () => {
    const s = serveur();
    await activerImudp(s);
    const svc = (s as unknown as { executor: { rsyslogService: {
      recevoir(ip: string, c: string): void } } }).executor.rsyslogService;
    // RFC 3164 §4.3.3 : traiter comme `user.notice` plutot que perdre.
    svc.recevoir('10.8.8.8', 'message sans priorite');
    expect(await s.executeCommand('grep 10.8.8.8 /var/log/syslog')).toContain('message sans priorite');
  }, 30_000);

  it('une regle `local7` dediee ecrit un fichier par equipement', async () => {
    const s = serveur();
    await s.executeCommand('mkdir -p /var/log/network');
    // `printf` interprete `%F` comme une conversion : le gabarit passe
    // par `echo`, comme un operateur qui edite le fichier.
    await s.executeCommand(
      "echo 'local7.*  /var/log/network/%FROMHOST-IP%.log' > /etc/rsyslog.d/10-network.conf",
    );
    await activerImudp(s);
    const svc = (s as unknown as { executor: { rsyslogService: {
      recevoir(ip: string, c: string): void } } }).executor.rsyslogService;
    svc.recevoir('10.0.12.1', '<189>Aug 11 05:00:00 R1 OSPF: adjacence');
    expect(await s.executeCommand('cat /var/log/network/10.0.12.1.log')).toContain('adjacence');
  }, 30_000);
});
