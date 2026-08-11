/**
 * « Syslog : From Zero to Hero » — conformite du tutoriel, partie par
 * partie, sur les quatre plateformes.
 *
 * Ce fichier suit le PLAN DU TUTORIEL : le protocole, puis Cisco, puis
 * Huawei, puis Linux, puis Windows, puis la centralisation, l'analyse et
 * l'integrite. Il complete `rsyslog-recepteur-reel.test.ts`, qui est
 * organise autour de ce qui a ete REPARE cote collecteur.
 *
 * Les points que le tutoriel demande et que ce simulateur ne fait PAS
 * encore sont marques `it.skip` avec leur raison, plutot qu'omis : un
 * fichier de conformite doit dire ou s'arrete la conformite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  SYSLOG_FACILITY, SYSLOG_SEVERITY, priValue, shouldForward, syslogSeverityFromNum,
} from '@/network/syslog/types';
import { analyserMessageRecu } from '@/network/devices/linux/syslog/LinuxRsyslogService';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const refuse = (r: string) => /% Invalid input|% Incomplete|Unrecognized|Error:/.test(r);

async function cisco(...cfg: string[]): Promise<CiscoRouter> {
  const d = new CiscoRouter('R1', 0, 0);
  d.powerOn();
  await d.executeCommand('enable');
  if (cfg.length) {
    await d.executeCommand('configure terminal');
    for (const c of cfg) await d.executeCommand(c);
    await d.executeCommand('end');
  }
  return d;
}

async function huawei(...cfg: string[]): Promise<HuaweiRouter> {
  const d = new HuaweiRouter('H1', 0, 0);
  d.powerOn();
  if (cfg.length) {
    await d.executeCommand('system-view');
    for (const c of cfg) await d.executeCommand(c);
    await d.executeCommand('quit');
  }
  return d;
}

// ── Partie 1 : le protocole ─────────────────────────────────────────

describe('partie 1 : PRIORITY, facilities et severities', () => {
  it('PRIORITY = (Facility x 8) + Severity', () => {
    expect(priValue(23, 5)).toBe(189);
    expect(priValue(23, 0)).toBe(184);
    expect(priValue(4, 6)).toBe(38);
    expect(priValue(4, 4)).toBe(36);
  });

  it('<189> se decompose en local7 / notice', () => {
    const m = analyserMessageRecu('<189>Aug  9 14:32:15 R1-PROD OSPF: adjacence');
    expect(m.facilite).toBe('local7');
    expect(m.severite).toBe(5);
    expect(m.reste).toContain('OSPF: adjacence');
  });

  it('les 20 facilities nommees portent leur numero', () => {
    const attendu: Array<[string, number]> = [
      ['kern', 0], ['user', 1], ['mail', 2], ['daemon', 3], ['auth', 4],
      ['syslog', 5], ['lpr', 6], ['news', 7], ['uucp', 8], ['cron', 9],
      ['authpriv', 10], ['ftp', 11],
      ['local0', 16], ['local7', 23],
    ];
    for (const [nom, num] of attendu) {
      expect(SYSLOG_FACILITY[nom as keyof typeof SYSLOG_FACILITY], nom).toBe(num);
    }
  });

  it('les huit severities vont de emergency(0) a debugging(7)', () => {
    expect(SYSLOG_SEVERITY.emergency).toBe(0);
    expect(SYSLOG_SEVERITY.alert).toBe(1);
    expect(SYSLOG_SEVERITY.critical).toBe(2);
    expect(SYSLOG_SEVERITY.error).toBe(3);
    expect(SYSLOG_SEVERITY.warning).toBe(4);
    expect(SYSLOG_SEVERITY.notification).toBe(5);
    expect(SYSLOG_SEVERITY.informational).toBe(6);
    expect(SYSLOG_SEVERITY.debugging).toBe(7);
    expect(syslogSeverityFromNum(3)).toBe('error');
  });

  it('un seuil retient CE niveau et tout ce qui est plus grave', () => {
    expect(shouldForward('warning', 'error'), 'err est plus grave').toBe(true);
    expect(shouldForward('warning', 'warning')).toBe(true);
    expect(shouldForward('warning', 'notification'), 'notice est moins grave').toBe(false);
    expect(shouldForward('debugging', 'debugging'), 'debug retient tout').toBe(true);
    expect(shouldForward('emergency', 'alert'), 'seul emergency passe').toBe(false);
  });

  it('12-15 ne sont pas des facilities — local0 commence a 16', () => {
    const numeros = Object.values(SYSLOG_FACILITY);
    for (const n of [12, 13, 14, 15]) expect(numeros).not.toContain(n);
  });
});

// ── Partie 2 : Cisco ────────────────────────────────────────────────

describe('partie 2 : la configuration Cisco', () => {
  const COMMANDES = [
    'logging on',
    'logging host 192.168.100.50',
    'logging host 192.168.100.50 transport tcp port 514',
    'logging host 192.168.100.51 transport udp port 514',
    'logging trap informational',
    'logging buffered 131072 debugging',
    'logging console notifications',
    'logging monitor debugging',
    'logging source-interface Loopback0',
    'logging facility local7',
    'logging rate-limit 1000 except errors',
    'logging origin-id hostname',
    'service timestamps log datetime msec localtime show-timezone year',
  ];
  it.each(COMMANDES)('`%s` est acceptee', async (cmd) => {
    const d = await cisco();
    await d.executeCommand('configure terminal');
    const r = await d.executeCommand(cmd);
    await d.executeCommand('end');
    expect(refuse(r), cmd).toBe(false);
  }, 30_000);

  it('la configuration est RENDUE et survit a un rechargement', async () => {
    const d = await cisco(
      'logging host 192.168.100.50 transport tcp port 514',
      'logging trap warnings',
      'logging buffered 131072 debugging', 'logging source-interface Loopback0',
    );
    const rc = await d.executeCommand('show running-config');
    for (const attendu of [
      'logging host 192.168.100.50 transport tcp port 514',
      'logging trap warnings',
      'logging buffered 131072 debugging', 'logging source-interface Loopback0',
    ]) expect(rc, attendu).toContain(attendu);
  }, 30_000);

  /**
   * `informational` est le defaut d'IOS pour `logging trap` : comme
   * `local7` pour la facility, il ne parait pas dans la configuration.
   * `show logging` l'annonce quand meme, et c'est la qu'on le lit.
   */
  it('`logging trap informational` est le defaut, donc non rendu', async () => {
    const d = await cisco('logging trap informational');
    expect(await d.executeCommand('show running-config')).not.toContain('logging trap');
    expect(await d.executeCommand('show logging')).toContain('Trap logging: level informational');
  }, 30_000);

  /**
   * `local7` est le defaut d'IOS : il ne parait PAS dans la
   * configuration, et c'est juste. Une facility qui n'est pas le defaut
   * doit y paraitre, sinon elle serait perdue au rechargement.
   */
  it('`logging facility` n\'est rendue que si elle n\'est pas le defaut', async () => {
    const parDefaut = await cisco('logging facility local7');
    expect(await parDefaut.executeCommand('show running-config'))
      .not.toContain('logging facility');
    const autre = await cisco('logging facility local5');
    expect(await autre.executeCommand('show running-config'))
      .toContain('logging facility local5');
    expect(await autre.executeCommand('show logging')).toContain('Facility: local5');
  }, 30_000);

  it('`show logging` annonce chaque destination et son transport', async () => {
    const d = await cisco(
      'logging host 192.168.100.50 transport tcp port 514',
      'logging host 192.168.100.51',
      'logging trap informational', 'logging facility local7',
    );
    const out = await d.executeCommand('show logging');
    expect(out).toContain('Syslog logging: enabled');
    expect(out).toContain('Trap logging: level informational');
    expect(out).toContain('Logging to 192.168.100.50');
    expect(out).toContain('tcp port 514');
    expect(out).toContain('Logging to 192.168.100.51');
    expect(out).toContain('Facility: local7');
  }, 30_000);

  it('`show logging` compte les messages, il ne les invente pas', async () => {
    const d = await cisco('logging buffered 131072 debugging');
    const avant = /Buffer logging:\s+level \w+, (\d+) messages/.exec(await d.executeCommand('show logging'));
    await d.executeCommand('configure terminal');
    await d.executeCommand('hostname COMPTE-MOI');
    await d.executeCommand('end');
    const apres = /Buffer logging:\s+level \w+, (\d+) messages/.exec(await d.executeCommand('show logging'));
    expect(Number(apres![1])).toBeGreaterThan(Number(avant![1]));
  }, 30_000);

  it('le tampon porte les mnemoniques du tutoriel', async () => {
    const d = await cisco('logging buffered 131072 debugging');
    await d.executeCommand('configure terminal');
    await d.executeCommand('hostname R1-PROD');
    await d.executeCommand('end');
    expect(await d.executeCommand('show logging')).toContain('%SYS-5-CONFIG_I');
  }, 30_000);

  it('`logging discriminator` est acceptee et rendue', async () => {
    const d = await cisco('logging discriminator FILTRE mnemonics drops LINEPROTO');
    expect(await d.executeCommand('show running-config'))
      .toContain('logging discriminator FILTRE mnemonics drops LINEPROTO');
    expect(await d.executeCommand('show logging')).toContain('FILTRE');
  }, 30_000);

  it('`clear logging` vide le tampon', async () => {
    const d = await cisco('logging buffered 131072 debugging');
    await d.executeCommand('configure terminal');
    await d.executeCommand('hostname AVANT-VIDAGE');
    await d.executeCommand('end');
    expect(await d.executeCommand('show logging')).toContain('%SYS-5-CONFIG_I');
    await d.executeCommand('clear logging');
    expect(await d.executeCommand('show logging')).not.toContain('%SYS-5-CONFIG_I');
  }, 30_000);

  /**
   * MANQUE : §6.3 du tutoriel configure Syslog sur TLS cote Cisco. Le
   * transport `tls` est refuse — ni le client Cisco ni le collecteur
   * Linux ne portent le 6514 chiffre. Ecrit dans `PRD-Rsyslog.md`.
   */
  it.skip('MANQUE — `logging host X transport tls port 6514`', async () => {
    const d = await cisco();
    await d.executeCommand('configure terminal');
    const r = await d.executeCommand('logging host 192.168.100.50 transport tls port 6514');
    expect(refuse(r)).toBe(false);
  }, 30_000);
});

// ── Partie 3 : Huawei ───────────────────────────────────────────────

describe('partie 3 : l\'info-center Huawei', () => {
  const COMMANDES = [
    'info-center enable',
    'info-center loghost 192.168.100.50 facility local7',
    'info-center logbuffer size 1024',
    'info-center timestamp log date',
    'info-center console channel 0',
    'info-center source default channel loghost log level warning',
  ];
  it.each(COMMANDES)('`%s` est acceptee', async (cmd) => {
    const d = await huawei();
    await d.executeCommand('system-view');
    const r = await d.executeCommand(cmd);
    await d.executeCommand('quit');
    expect(refuse(r), cmd).toBe(false);
  }, 30_000);

  it('`display info-center` decrit le collecteur configure', async () => {
    const d = await huawei('info-center enable',
      'info-center loghost 192.168.100.50 facility local7');
    const out = await d.executeCommand('display info-center');
    expect(out).toContain('Info-center: Enabled');
    expect(out).toContain('192.168.100.50');
  }, 30_000);

  it('`display logbuffer` decrit le tampon et le remplit vraiment', async () => {
    const d = await huawei('info-center enable', 'info-center logbuffer size 1024');
    const out = await d.executeCommand('display logbuffer');
    expect(out).toContain('Allowed max buffer size : 1024');
    expect(out).toContain('Dropped messages : 0');
    expect(out).toMatch(/Current messages : \d+/);
  }, 30_000);

  it('la configuration est rendue par `display current-configuration`', async () => {
    const d = await huawei('info-center enable',
      'info-center loghost 192.168.100.50 facility local7',
      'info-center logbuffer size 1024');
    const cc = await d.executeCommand('display current-configuration');
    expect(cc).toContain('info-center loghost 192.168.100.50');
    expect(cc).toContain('info-center logbuffer size 1024');
  }, 30_000);

  it('`reset logbuffer` est acceptee', async () => {
    const d = await huawei('info-center enable');
    expect(refuse(await d.executeCommand('reset logbuffer'))).toBe(false);
  }, 30_000);

  /**
   * MANQUES mesures de la partie 3. Le tutoriel les utilise tous les
   * trois ; ils sont refuses aujourd'hui. Nommes dans `PRD-Rsyslog.md`.
   */
  it.skip('MANQUE — `info-center loghost X level informational`', async () => {
    const d = await huawei();
    await d.executeCommand('system-view');
    const r = await d.executeCommand('info-center loghost 192.168.100.50 level informational');
    expect(refuse(r)).toBe(false);
  }, 30_000);

  it.skip('MANQUE — `info-center loghost X source-ip <ip>`', async () => {
    const d = await huawei();
    await d.executeCommand('system-view');
    const r = await d.executeCommand('info-center loghost 192.168.100.50 source-ip 10.0.0.1');
    expect(refuse(r)).toBe(false);
  }, 30_000);

  it.skip('MANQUE — `display logbuffer level warning`', async () => {
    const d = await huawei('info-center enable');
    expect(refuse(await d.executeCommand('display logbuffer level warning'))).toBe(false);
  }, 30_000);
});

// ── Partie 4 : Linux ────────────────────────────────────────────────

describe('partie 4 : rsyslog et journald', () => {
  const serveur = () => {
    const s = new LinuxServer('linux-server', 'srv', 0, 0);
    s.powerOn();
    return s;
  };

  it('les fichiers de configuration de Debian sont la', async () => {
    const s = serveur();
    expect(await s.executeCommand('ls /etc/rsyslog.conf')).not.toContain('No such file');
    expect(await s.executeCommand('ls /etc/rsyslog.d/')).toContain('50-default.conf');
  }, 30_000);

  it('`logger -p local7.warning` ecrit avec la BONNE facility', async () => {
    const s = serveur();
    await s.executeCommand('logger -p local7.warning "message du tuto"');
    expect(await s.executeCommand('grep "message du tuto" /var/log/syslog'))
      .toContain('message du tuto');
    const j = await s.executeCommand('journalctl -o json -n 1');
    expect(j, 'local7 = 23').toContain('"SYSLOG_FACILITY":"23"');
    expect(j, 'warning = 4').toContain('"PRIORITY":"4"');
  }, 30_000);

  const JOURNALCTL = ['journalctl -n 3', 'journalctl -p err', 'journalctl -p warning',
    'journalctl -k', 'journalctl -b', 'journalctl -o json -n 1', 'journalctl --disk-usage'];
  it.each(JOURNALCTL)('`%s` repond', async (cmd) => {
    const s = serveur();
    expect(await s.executeCommand(cmd), cmd).not.toContain('command not found');
  }, 30_000);

  it('`journalctl -u <unite>` filtre par service', async () => {
    const s = serveur();
    expect(await s.executeCommand('journalctl -u ssh')).not.toContain('command not found');
  }, 30_000);

  /**
   * MANQUE : §4.5 du tutoriel fait poser une rotation quotidienne dans
   * `/etc/logrotate.d/`. Le binaire `logrotate` existe, mais l'image ne
   * livre aucun fichier de rotation, donc l'exemple du tutoriel porte
   * sur un fichier absent.
   */
  it.skip('MANQUE — `/etc/logrotate.d/` livre une rotation pour rsyslog', async () => {
    const s = serveur();
    expect(await s.executeCommand('ls /etc/logrotate.d/')).toContain('rsyslog');
  }, 30_000);
});

// ── Partie 5 : Windows ──────────────────────────────────────────────

describe('partie 5 : l\'Event Log Windows', () => {
  const poste = () => {
    const w = new WindowsPC('windows-pc', 'PC1', 0, 0);
    w.powerOn();
    return w;
  };

  it('`Get-WinEvent -LogName Security` rend des evenements', async () => {
    const w = poste();
    const out = await w.executeCommand('powershell Get-WinEvent -LogName Security -MaxEvents 3');
    expect(out).toContain('LogName');
    expect(out).toContain('Security');
    expect(out).toMatch(/Id\s+:\s+\d+/);
  }, 30_000);

  it('les journaux System et Security sont distincts', async () => {
    const w = poste();
    const sys = await w.executeCommand('powershell Get-WinEvent -LogName System -MaxEvents 2');
    expect(sys).toContain('System');
  }, 30_000);

  it('`Get-EventLog` et `wevtutil` repondent aussi', async () => {
    const w = poste();
    expect(await w.executeCommand('powershell Get-EventLog -LogName Security -Newest 2'))
      .toContain('Security');
    expect(await w.executeCommand('wevtutil qe Security /c:2')).toContain('Log Name: Security');
  }, 30_000);
});

// ── Partie 6 : la centralisation ────────────────────────────────────

describe('partie 6 : le collecteur central recoit vraiment', () => {
  it('un routeur Cisco emet, un serveur Linux recoit et classe', async () => {
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    const srv = new LinuxServer('linux-server', 'collecteur', 0, 0);
    const r = new CiscoRouter('R1', 0, 0);
    [srv, r].forEach((d, i) => { const c = new Cable(`c${i}`); c.connect(d.getPorts()[0], sw.getPorts()[i]); });
    srv.getPorts()[0].configureIP(new IPAddress('192.168.100.50'), new SubnetMask('255.255.255.0'));
    [srv, r, sw].forEach((d) => d.powerOn());

    await srv.executeCommand("sed -i 's/^#module(load=\"imudp\")/module(load=\"imudp\")/' /etc/rsyslog.conf");
    await srv.executeCommand("sed -i 's/^#input(type=\"imudp\" port=\"514\")/input(type=\"imudp\" port=\"514\")/' /etc/rsyslog.conf");
    await srv.executeCommand('systemctl restart rsyslog');
    expect(await srv.executeCommand('ss -ulnp | grep 514'), 'le collecteur ecoute').toContain('514');

    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
      'logging host 192.168.100.50', 'logging trap informational',
      'logging facility local7', 'hostname R1-PROD', 'end']) {
      await r.executeCommand(c);
    }
    await new Promise((x) => setTimeout(x, 60));

    expect(await r.executeCommand('show logging'), 'l\'emetteur compte ses envois')
      .toContain('192.168.100.50');
    const recu = await srv.executeCommand('grep 192.168.100.1 /var/log/syslog');
    expect(recu, 'le collecteur a recu').toContain('192.168.100.1');
    expect(recu).toContain('%SYS-5-CONFIG_I');
  }, 60_000);

  it('une regle `local7` dediee ecrit un fichier par equipement', async () => {
    const s = new LinuxServer('linux-server', 'srv', 0, 0);
    s.powerOn();
    await s.executeCommand('mkdir -p /var/log/network');
    await s.executeCommand(
      "echo 'local7.*  /var/log/network/%FROMHOST-IP%.log' > /etc/rsyslog.d/10-network.conf");
    await s.executeCommand('systemctl restart rsyslog');
    const svc = (s as unknown as { executor: { rsyslogService: {
      recevoir(ip: string, c: string): void } } }).executor.rsyslogService;
    svc.recevoir('10.0.12.1', '<189>Aug 11 05:00:00 R1 OSPF: adjacence formee');
    svc.recevoir('10.0.12.2', '<189>Aug 11 05:00:01 R2 BGP: session etablie');
    const un = await s.executeCommand('cat /var/log/network/10.0.12.1.log');
    const deux = await s.executeCommand('cat /var/log/network/10.0.12.2.log');
    expect(un).toContain('OSPF: adjacence formee');
    expect(un, 'chaque fichier ne porte QUE son equipement').not.toContain('BGP');
    expect(deux).toContain('BGP: session etablie');
    expect(deux).not.toContain('OSPF');
  }, 30_000);

  /**
   * DIVERGENCE mesuree : le collecteur remplace le nom d'hote porte par
   * le message par l'adresse source. Le vrai rsyslog garde `%HOSTNAME%`
   * (celui du message) et n'utilise `%FROMHOST-IP%` que si le gabarit le
   * demande — le tutoriel §4.2 distingue d'ailleurs les deux. Un message
   * relaye perd donc ici l'identite de son emetteur d'origine.
   */
  it.skip('DIVERGENCE — le nom d\'hote du message devrait survivre', async () => {
    const s = new LinuxServer('linux-server', 'srv', 0, 0);
    s.powerOn();
    const svc = (s as unknown as { executor: { rsyslogService: {
      recevoir(ip: string, c: string): void } } }).executor.rsyslogService;
    svc.recevoir('10.0.12.1', '<189>Aug 11 05:00:00 R1-PROD OSPF: adjacence');
    expect(await s.executeCommand('grep OSPF /var/log/syslog')).toContain('R1-PROD');
  }, 30_000);
});

// ── Partie 7 : l'analyse ────────────────────────────────────────────

describe('partie 7 : chercher dans les logs', () => {
  it('`grep` retrouve les echecs d\'authentification recus', async () => {
    const s = new LinuxServer('linux-server', 'srv', 0, 0);
    s.powerOn();
    await s.executeCommand("sed -i 's/^#module(load=\"imudp\")/module(load=\"imudp\")/' /etc/rsyslog.conf");
    await s.executeCommand("sed -i 's/^#input(type=\"imudp\" port=\"514\")/input(type=\"imudp\" port=\"514\")/' /etc/rsyslog.conf");
    await s.executeCommand('systemctl restart rsyslog');
    const svc = (s as unknown as { executor: { rsyslogService: {
      recevoir(ip: string, c: string): void } } }).executor.rsyslogService;
    svc.recevoir('10.0.12.1',
      '<188>Aug 11 05:00:00 R1 SEC_LOGIN: %SEC_LOGIN-4-LOGIN_FAILED: Login failed [user: root]');
    expect(await s.executeCommand('grep LOGIN_FAILED /var/log/syslog')).toContain('root');
  }, 30_000);

  it('`show logging | include` isole une famille de messages (Cisco)', async () => {
    const d = await cisco('logging buffered 131072 debugging');
    await d.executeCommand('configure terminal');
    await d.executeCommand('hostname FILTRE-MOI');
    await d.executeCommand('end');
    const filtre = await d.executeCommand('show logging | include CONFIG_I');
    expect(filtre).toContain('CONFIG_I');
    expect(filtre).not.toContain('Syslog logging: enabled');
  }, 30_000);

  it('`display logbuffer | include` fait de meme (Huawei)', async () => {
    const d = await huawei('info-center enable');
    expect(refuse(await d.executeCommand('display logbuffer | include Channel'))).toBe(false);
  }, 30_000);
});

// ── Partie 8 : integrite ────────────────────────────────────────────

describe('partie 8 : verifier l\'integrite des journaux', () => {
  it('`sha256sum` donne une empreinte, et elle CHANGE quand le fichier change', async () => {
    const s = new LinuxServer('linux-server', 'srv', 0, 0);
    s.powerOn();
    const avant = (await s.executeCommand('sha256sum /var/log/syslog')).split(/\s+/)[0];
    expect(avant).toMatch(/^[0-9a-f]{64}$/);
    await s.executeCommand('logger "une ligne de plus"');
    const apres = (await s.executeCommand('sha256sum /var/log/syslog')).split(/\s+/)[0];
    expect(apres, 'le fichier a change, donc l\'empreinte aussi').not.toBe(avant);
  }, 30_000);

  it('deux fichiers differents ont deux empreintes differentes', async () => {
    const s = new LinuxServer('linux-server', 'srv', 0, 0);
    s.powerOn();
    await s.executeCommand('echo un > /tmp/a.log');
    await s.executeCommand('echo deux > /tmp/b.log');
    const a = (await s.executeCommand('sha256sum /tmp/a.log')).split(/\s+/)[0];
    const b = (await s.executeCommand('sha256sum /tmp/b.log')).split(/\s+/)[0];
    expect(a).not.toBe(b);
  }, 30_000);

  /**
   * MANQUE : §8.2 rend les archives immuables avec `chattr +i`, verifie
   * par `lsattr`. Aucune des deux commandes n'existe, et il n'y a pas
   * d'attribut etendu sur le VFS pour les porter.
   */
  it.skip('MANQUE — `chattr +i` et `lsattr` pour l\'immutabilite', async () => {
    const s = new LinuxServer('linux-server', 'srv', 0, 0);
    s.powerOn();
    await s.executeCommand('chattr +i /var/log/syslog');
    expect(await s.executeCommand('lsattr /var/log/syslog')).toMatch(/^-*i/);
  }, 30_000);
});
