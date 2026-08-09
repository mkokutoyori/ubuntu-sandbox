/**
 * PRD-NTP-Tutoriel.md §3 / lot N2 — les labs NTP Huawei du tutoriel
 * « NTP : From Zero to Hero » (§4), reproduits.
 *
 * Le defaut central n'etait pas d'affichage. Sur une machine ou l'on
 * venait de taper quatre serveurs :
 *
 *     [R1]display ntp-service sessions
 *     No NTP associations
 *
 * ...pendant que `display current-configuration` les listait tous les
 * quatre. Le CLI ecrivait dans le service de gestion — pour
 * `unicast-server`, dans un sac de chaines brutes — et les vues lisaient
 * le `NtpAgent`, celui qui porte le protocole. **Aucune commande NTP
 * tapee sur un Huawei n'atteignait donc le moteur**, alors que le meme
 * moteur synchronise un Cisco depuis toujours.
 *
 * La forme du fichier suit ce constat : le premier bloc verifie que la
 * machine se SYNCHRONISE, pas qu'elle affiche quelque chose. Et le
 * dernier compare les deux plateformes entre elles — quelle que soit la
 * bonne reponse, un Cisco et un Huawei branches au meme serveur ne
 * peuvent pas etre l'un synchronise et l'autre non.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { analyserNtpVrp } from '@/network/devices/shells/huawei/huaweiNtpCommands';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/** Le serveur du tutoriel : un maitre NTP de strate 2 en 192.168.100.5. */
async function serveur() {
  const r = new CiscoRouter(`SRV${++serie}`);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.100.5 255.255.255.0', 'no shutdown', 'exit',
    'ntp master 2', 'end']) await r.executeCommand(c);
  return r;
}

/** Un Huawei cable au serveur, adresse mais sans configuration NTP. */
async function huawei(srv: CiscoRouter, ip = '192.168.100.9') {
  const r = new HuaweiRouter(`HW${++serie}`);
  new Cable(`n${serie}`).connect(
    srv.getPort('GigabitEthernet0/0')!, r.getPort('GE0/0/0')!);
  for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
    `ip address ${ip} 255.255.255.0`, 'undo shutdown', 'quit', 'quit']) {
    await r.executeCommand(c);
  }
  return r;
}

async function conf(r: HuaweiRouter, ...cmds: string[]) {
  const sorties: string[] = [];
  await r.executeCommand('system-view');
  for (const c of cmds) sorties.push(await r.executeCommand(c));
  await r.executeCommand('quit');
  return sorties;
}

const ligne = (s: string, debut: string) =>
  s.split('\n').find((l) => l.trim().startsWith(debut))?.trim() ?? '';
const lignesNtp = (cfg: string) =>
  cfg.split('\n').filter((l) => l.trim().startsWith('ntp-service')).map((l) => l.trim());

describe('§4.1 — le client Huawei se synchronise pour de vrai', () => {
  it('`ntp-service unicast-server` amene la strate juste en dessous', async () => {
    const srv = await serveur();
    const r = await huawei(srv);
    expect(await r.executeCommand('display ntp-service status'))
      .toContain('Clock status: unsynchronized');
    await conf(r, 'ntp-service unicast-server 192.168.100.5 preference');
    const st = await r.executeCommand('display ntp-service status');
    expect(st).toContain('Clock status: synchronized');
    expect(st).toContain('Clock stratum: 3');
    expect(st).toContain('Reference clock ID: 192.168.100.5');
  });

  it('la session apparait dans la vue, marquee `*`', async () => {
    // Elle repondait `No NTP associations` : les deux magasins.
    const srv = await serveur();
    const r = await huawei(srv);
    await conf(r, 'ntp-service unicast-server 192.168.100.5 preference');
    const v = await r.executeCommand('display ntp-service sessions');
    expect(v).not.toContain('No NTP');
    expect(ligne(v, '*192.168.100.5')).toContain('192.168.100.5');
    expect(v).toContain('Total sessions: 1');
  });

  it('une source injoignable est comptee sans etre retenue', async () => {
    const srv = await serveur();
    const r = await huawei(srv);
    await conf(r, 'ntp-service unicast-server 192.168.100.5 preference',
      'ntp-service unicast-server 10.99.99.99');
    const v = await r.executeCommand('display ntp-service sessions');
    expect(v).toContain('Total sessions: 2');
    // `reach` etait ecrit `377` EN DUR pour toute association, y compris
    // celles qui n'avaient jamais repondu : la vue affirmait huit
    // reponses sur huit d'un serveur muet.
    expect(ligne(v, '10.99.99.99')).toMatch(/\b000\b/);
  });

  it('un second `unicast-server` sur la meme adresse met a jour', async () => {
    // Le sac de chaines empilait deux lignes : la configuration rendue
    // decrivait un serveur configure deux fois.
    const r = new HuaweiRouter(`D${++serie}`);
    await conf(r, 'ntp-service unicast-server 192.168.100.5',
      'ntp-service unicast-server 192.168.100.5 preference');
    const l = lignesNtp(await r.executeCommand('display current-configuration'));
    expect(l.filter((x) => x.includes('192.168.100.5'))).toHaveLength(1);
    expect(l[0]).toBe('ntp-service unicast-server 192.168.100.5 preference');
  });
});

describe('§4.2 — maitre local', () => {
  it('`ntp-service refclock-master 7` synchronise la machine', async () => {
    // Elle rangeait la chaine `7` et restait `unsynchronized`, stratum 16.
    const r = new HuaweiRouter(`M${++serie}`);
    await conf(r, 'ntp-service refclock-master 7');
    const st = await r.executeCommand('display ntp-service status');
    expect(st).toContain('Clock status: synchronized');
    expect(st).toContain('Clock stratum: 7');
    // VRP ecrit `LOCAL(0)` la ou IOS ecrit `LOCL`.
    expect(st).toContain('Reference clock ID: LOCAL(0)');
    expect(st).toContain('Root dispersion: 0.00 ms');
  });

  it('et elle se relit dans la configuration', async () => {
    const r = new HuaweiRouter(`M${++serie}`);
    await conf(r, 'ntp-service refclock-master 7');
    expect(lignesNtp(await r.executeCommand('display current-configuration')))
      .toContain('ntp-service refclock-master 7');
  });
});

describe('§4.3 et §4.4 — pair et authentification', () => {
  it('`unicast-peer` est rendu comme un pair', async () => {
    const r = new HuaweiRouter(`P${++serie}`);
    await conf(r, 'ntp-service unicast-peer 10.0.12.2');
    const l = lignesNtp(await r.executeCommand('display current-configuration'));
    expect(l).toContain('ntp-service unicast-peer 10.0.12.2');
    expect(l).not.toContain('ntp-service unicast-server 10.0.12.2');
  });

  it('la clé survit a la commande qui la pose', async () => {
    // L'analyseur lisait les positions 1/2/3, donc retenait le mot
    // `authentication-mode` comme ALGORITHME et perdait la clé. La
    // configuration rendue ecrivait le mot deux fois de suite.
    const r = new HuaweiRouter(`A${++serie}`);
    await conf(r, 'ntp-service authentication enable',
      'ntp-service authentication-keyid 1 authentication-mode md5 ClefNTP2024',
      'ntp-service reliable authentication-keyid 1');
    const l = lignesNtp(await r.executeCommand('display current-configuration'));
    expect(l).toContain('ntp-service authentication-keyid 1 authentication-mode md5 ClefNTP2024');
    expect(l.join('\n')).not.toContain('authentication-mode authentication-mode');
    expect(l).toContain('ntp-service authentication enable');
    expect(l).toContain('ntp-service reliable authentication-keyid 1');
  });

  it('la clé garde sa casse', async () => {
    const r = new HuaweiRouter(`A${++serie}`);
    await conf(r, 'ntp-service authentication-keyid 1 authentication-mode md5 ClefNTP2024');
    expect(await r.executeCommand('display current-configuration')).toContain('ClefNTP2024');
  });

  it('un serveur peut porter sa clé', async () => {
    const r = new HuaweiRouter(`AK${++serie}`);
    await conf(r, 'ntp-service authentication-keyid 1 authentication-mode md5 Secret1',
      'ntp-service reliable authentication-keyid 1',
      'ntp-service unicast-server 192.168.100.5 authentication-keyid 1');
    expect(lignesNtp(await r.executeCommand('display current-configuration')))
      .toContain('ntp-service unicast-server 192.168.100.5 authentication-keyid 1');
  });

  it('`undo` retire ce que la commande avait pose', async () => {
    const r = new HuaweiRouter(`U${++serie}`);
    await conf(r, 'ntp-service unicast-server 192.168.100.5',
      'ntp-service authentication enable', 'ntp-service source-interface LoopBack0');
    await conf(r, 'undo ntp-service unicast-server 192.168.100.5',
      'undo ntp-service authentication enable', 'undo ntp-service source-interface LoopBack0');
    expect(lignesNtp(await r.executeCommand('display current-configuration'))).toEqual([]);
  });
});

describe('§4.5 — les vues portent de quoi diagnostiquer', () => {
  it('`display ntp-service status` a ses onze lignes', async () => {
    const srv = await serveur();
    const r = await huawei(srv);
    await conf(r, 'ntp-service unicast-server 192.168.100.5 preference');
    const st = await r.executeCommand('display ntp-service status');
    for (const champ of ['Clock status:', 'Clock stratum:', 'Reference clock ID:',
      'Nominal frequency:', 'Actual frequency:', 'Clock precision:', 'Clock offset:',
      'Root delay:', 'Root dispersion:', 'Reference time:']) {
      expect(st, champ).toContain(champ);
    }
    // VRP annonce 100 Hz et `2^17` la ou IOS annonce 250 Hz et `2**18` :
    // ce sont deux plateformes, pas une constante partagee.
    expect(st).toContain('Nominal frequency: 100.0000 Hz');
    expect(st).toContain('Clock precision: 2^17');
  });

  it('`display ntp-service sessions verbose` existe et ajoute quelque chose', async () => {
    // Elle n'existait pas du tout : `Unrecognized command`.
    const srv = await serveur();
    const r = await huawei(srv);
    await conf(r, 'ntp-service unicast-server 192.168.100.5 preference');
    const bref = await r.executeCommand('display ntp-service sessions');
    const verb = await r.executeCommand('display ntp-service sessions verbose');
    expect(verb).not.toMatch(/Unrecognized command/);
    expect(verb).not.toBe(bref);
    expect(verb).toContain('sync dist:');
    expect(verb).toContain('role: client');
  });

  it('sans session, la vue le dit au lieu de mentir', async () => {
    const r = new HuaweiRouter(`V${++serie}`);
    expect(await r.executeCommand('display ntp-service sessions'))
      .toContain('No NTP session exists');
  });

  it('la vue nomme l\'interface source quand il y en a une', async () => {
    const r = new HuaweiRouter(`SI${++serie}`);
    await conf(r, 'ntp-service unicast-server 192.168.100.5',
      'ntp-service source-interface LoopBack0');
    expect(await r.executeCommand('display ntp-service sessions'))
      .toContain('source-interface: LoopBack0');
  });
});

describe('§4.1 — le fuseau horaire VRP', () => {
  it('`clock timezone WAT add 01:00:00` decale l\'heure affichee', async () => {
    // L'analyseur attendait `+01:00`, une forme que VRP n'emet jamais :
    // aucun fuseau configure sur un Huawei n'etait applique, et
    // `display clock` repondait UTC.
    const r = new HuaweiRouter(`TZ${++serie}`);
    const avant = await r.executeCommand('display clock');
    await conf(r, 'clock timezone WAT add 01:00:00');
    const apres = await r.executeCommand('display clock');
    expect(avant).toContain('Time Zone(UTC) : UTC');
    expect(apres).toContain('Time Zone(WAT) : UTC add 01:00:00');
    const h = (s: string) => parseInt(s.split('\n')[0].split(' ')[1].slice(0, 2), 10);
    expect((h(avant) + 1) % 24).toBe(h(apres));
  });

  it('`minus` decale dans l\'autre sens', async () => {
    const r = new HuaweiRouter(`TZ${++serie}`);
    const avant = await r.executeCommand('display clock');
    await conf(r, 'clock timezone EST minus 05:00:00');
    const apres = await r.executeCommand('display clock');
    expect(apres).toContain('Time Zone(EST) : UTC minus 05:00:00');
    const h = (s: string) => parseInt(s.split('\n')[0].split(' ')[1].slice(0, 2), 10);
    expect((h(avant) + 19) % 24).toBe(h(apres));
  });
});

describe('la grammaire valide au lieu de lire des positions', () => {
  const REFUS = /^Error: Wrong parameter found at '\^' position\./;

  it('les bornes de VRP sont tenues', async () => {
    const r = new HuaweiRouter(`G${++serie}`);
    await r.executeCommand('system-view');
    for (const mauvais of ['ntp-service unicast-server pas-une-ip',
      'ntp-service refclock-master 99', 'ntp-service refclock-master 0',
      'ntp-service zzz', 'ntp-service authentication-keyid 1 md5 X',
      'ntp-service authentication enabled', 'ntp-service access zzz 2000']) {
      expect(await r.executeCommand(mauvais), mauvais).toMatch(REFUS);
    }
  });

  it('un mot inconnu ne devient pas une ligne de configuration', async () => {
    // Le sac de chaines brutes rangeait TOUT ce qu'il ne reconnaissait
    // pas, donc une faute de frappe ressortait dans la configuration et
    // etait rejouee a l'import.
    const r = new HuaweiRouter(`G${++serie}`);
    await conf(r, 'ntp-service zzz');
    expect(await r.executeCommand('display current-configuration')).not.toContain('zzz');
  });

  it('les formes legitimes passent', () => {
    for (const args of [['unicast-server', '10.0.0.1'],
      ['unicast-server', '10.0.0.1', 'preference'],
      ['unicast-server', '10.0.0.1', 'authentication-keyid', '3', 'preference'],
      ['unicast-peer', '10.0.0.2', 'version', '3'],
      ['refclock-master'], ['refclock-master', '7'],
      ['source-interface', 'LoopBack0'], ['authentication', 'enable'],
      ['authentication-keyid', '1', 'authentication-mode', 'md5', 'Secret'],
      ['reliable', 'authentication-keyid', '1'],
      ['access', 'peer', '2000']]) {
      expect(analyserNtpVrp(args).statut, args.join(' ')).toBe('ok');
    }
  });

  it('l\'ordre des options est libre, comme sur VRP', () => {
    const a = analyserNtpVrp(['unicast-server', '10.0.0.1', 'preference', 'authentication-keyid', '5']);
    expect(a.statut).toBe('ok');
    if (a.statut === 'ok' && a.action.quoi === 'association') {
      expect(a.action.preference).toBe(true);
      expect(a.action.keyId).toBe(5);
    }
  });
});

describe('les deux plateformes s\'accordent sur le meme serveur', () => {
  it('un Cisco et un Huawei branches au meme maitre atteignent la meme strate', async () => {
    // C'est la propriete la plus forte du fichier : elle se verifie sans
    // connaitre VRP. Le Huawei restait a 16 pendant que le Cisco passait
    // a 3, sur le meme fil et le meme serveur.
    const srv = await serveur();
    const hw = await huawei(srv, '192.168.100.9');
    const cisco = new CiscoRouter(`CX${++serie}`);
    new Cable(`x${serie}`).connect(
      srv.getPort('GigabitEthernet0/1')!, cisco.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/1',
      'ip address 192.168.101.5 255.255.255.0', 'no shutdown', 'end']) {
      await srv.executeCommand(c);
    }
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.101.9 255.255.255.0', 'no shutdown', 'exit',
      'ntp server 192.168.101.5', 'end']) await cisco.executeCommand(c);
    await conf(hw, 'ntp-service unicast-server 192.168.100.5');

    expect(await cisco.executeCommand('show ntp status')).toContain('stratum 3');
    expect(await hw.executeCommand('display ntp-service status')).toContain('Clock stratum: 3');
  });

  it('la configuration rendue REFAIT la machine', async () => {
    const srv = await serveur();
    const source = await huawei(srv);
    await conf(source, 'ntp-service unicast-server 192.168.100.5 preference',
      'ntp-service unicast-peer 10.0.12.2', 'ntp-service source-interface LoopBack0',
      'ntp-service authentication enable',
      'ntp-service authentication-keyid 1 authentication-mode md5 ClefNTP2024',
      'ntp-service reliable authentication-keyid 1',
      'ntp-service refclock-master 7');
    const config = lignesNtp(await source.executeCommand('display current-configuration'));
    expect(config.length).toBeGreaterThan(5);

    const cible = new HuaweiRouter(`RJ${++serie}`);
    await conf(cible, ...config);
    expect(lignesNtp(await cible.executeCommand('display current-configuration')))
      .toEqual(config);
  });
});
