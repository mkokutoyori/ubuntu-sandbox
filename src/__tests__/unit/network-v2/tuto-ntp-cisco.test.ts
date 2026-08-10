/**
 * PRD-NTP-Tutoriel.md §2 / lot N1 — les labs NTP Cisco du tutoriel
 * « NTP : From Zero to Hero », reproduits.
 *
 * La suite suit le tutoriel section par section (§3.1 a §3.8, puis §8 et
 * §9) plutot que le decoupage du code : ce qu'elle verifie est qu'un
 * lecteur peut TAPER ce qui est ecrit et LIRE ce qui est montre.
 *
 * Ce que la mesure preliminaire avait trouve, et que ces cas fixent :
 *
 * - `show ntp` etait un greedy qui AVALAIT toute sa queue, si bien que
 *   `show ntp associations detail`, `show ntp authentication-keys` et
 *   meme `show ntp packets` -- qui n'existe pas -- rendaient tous le
 *   meme tableau ;
 * - `ntp authentication-key 1 md5 ClefNTP2024Secret` etait range
 *   `clefntp2024secret` : la ligne entiere etait mise en minuscules pour
 *   comparer les mots-cles, et la CLE en sortait. Une configuration
 *   relue fabriquait une autre clé, donc un echec d'authentification ;
 * - `show ntp status` n'avait que quatre lignes sur huit, sans aucune de
 *   celles qu'un audit lit (`root delay`, `root dispersion`,
 *   `loopfilter state`, `last update`) ;
 * - `ntp disable` en vue d'interface -- le durcissement du §9 -- etait
 *   refusee, et `no ntp allow mode control` comme `ntp update-calendar`
 *   etaient acceptees puis rangees nulle part.
 *
 * Le moteur, lui, etait deja reel : la synchronisation ci-dessous passe
 * par de vrais paquets UDP/123 sur un vrai cable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/** Le serveur du tutoriel : 192.168.100.5, maitre NTP de strate 2. */
async function serveur(ip = '192.168.100.5', strate = 2) {
  const r = new CiscoRouter(`SRV${++serie}`);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit',
    `ntp master ${strate}`, 'end']) await r.executeCommand(c);
  return r;
}

/** Un client cable au serveur, sans configuration NTP encore. */
async function client(srv: CiscoRouter, ip = '192.168.100.9') {
  const r = new CiscoRouter(`R${++serie}`);
  new Cable(`ntp${serie}`).connect(
    srv.getPort('GigabitEthernet0/0')!, r.getPort('GigabitEthernet0/0')!);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit', 'end']) {
    await r.executeCommand(c);
  }
  return r;
}

/** Taper une suite de commandes en configuration, comme le tutoriel. */
async function conf(r: CiscoRouter, ...cmds: string[]) {
  const sorties: string[] = [];
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const c of cmds) sorties.push(await r.executeCommand(c));
  await r.executeCommand('end');
  return sorties;
}

const ligne = (s: string, debut: string) =>
  s.split('\n').find((l) => l.trim().startsWith(debut))?.trim() ?? '';

describe('§3.1 — le client se synchronise pour de vrai', () => {
  it('`ntp server` amene la strate juste en dessous de celle du serveur', async () => {
    const srv = await serveur('192.168.100.5', 2);
    const r = await client(srv);
    expect(await r.executeCommand('show ntp status'))
      .toMatch(/Clock is unsynchronized, stratum 16/);
    await conf(r, 'ntp server 192.168.100.5 prefer');
    const st = await r.executeCommand('show ntp status');
    expect(st).toMatch(/Clock is synchronized, stratum 3/);
    expect(st).toContain('reference is 192.168.100.5');
  });

  it('le tableau des associations marque la source retenue d\'un `*`', async () => {
    const srv = await serveur();
    const r = await client(srv);
    await conf(r, 'ntp server 192.168.100.5 prefer');
    const t = await r.executeCommand('show ntp associations');
    const l = ligne(t, '*~');
    expect(l, t).toContain('192.168.100.5');
    // `reach` est en OCTAL, et une seule reponse pose le bit de poids
    // fort : 200 en octal, soit 10000000. C'est ce que le §8 du tuto
    // apprend a lire.
    expect(l).toMatch(/\b200\b/);
  });

  it('une source injoignable reste `~` et n\'est jamais candidate', async () => {
    const srv = await serveur();
    const r = await client(srv);
    await conf(r, 'ntp server 10.99.99.99');
    const t = await r.executeCommand('show ntp associations');
    const l = ligne(t, '~10.99.99.99');
    expect(l, t).not.toBe('');
    expect(l).toMatch(/\b000\b/);
    expect(l).toMatch(/\b16\b/);
  });

  it('`show clock detail` nomme la source du temps', async () => {
    const srv = await serveur();
    const r = await client(srv);
    await conf(r, 'ntp server 192.168.100.5');
    expect(await r.executeCommand('show clock detail'))
      .toMatch(/Time source is NTP/);
  });
});

describe('§3.2 — fuseau horaire', () => {
  it('`clock timezone WAT 1 0` decale l\'heure affichee d\'une heure', async () => {
    const r = new CiscoRouter(`TZ${++serie}`);
    const utc = await r.executeCommand('show clock');
    await conf(r, 'clock timezone WAT 1 0');
    const wat = await r.executeCommand('show clock');
    expect(utc).toContain('UTC');
    expect(wat).toContain('WAT');
    const h = (s: string) => parseInt(s.trim().slice(0, 2), 10);
    expect((h(utc) + 1) % 24).toBe(h(wat));
  });

  it('le fuseau et l\'heure d\'ete se relisent dans la configuration', async () => {
    const r = new CiscoRouter(`TZ${++serie}`);
    await conf(r, 'clock timezone WAT 1 0',
      'clock summer-time CET recurring last Sun Mar 2:00 last Sun Oct 3:00');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('clock timezone WAT 1');
    expect(cfg).toMatch(/clock summer-time CET recurring/);
  });
});

describe('§3.4 et §3.5 — maitre local et mode pair', () => {
  it('`ntp master 7` rend la machine synchronisee sur elle-meme', async () => {
    const r = new CiscoRouter(`M${++serie}`);
    await conf(r, 'ntp master 7');
    const st = await r.executeCommand('show ntp status');
    expect(st).toMatch(/Clock is synchronized, stratum 7/);
    // Une reference LOCALE n'a pas de source : ni delai, ni dispersion.
    // La vue annoncait 16000 ms -- la valeur « aucune mesure » -- sur une
    // machine qu'elle declarait synchronisee, dans le meme bloc.
    expect(ligne(st, 'root dispersion')).toContain('root dispersion is 0.00 msec');
    expect(await r.executeCommand('show running-config')).toContain('ntp master 7');
  });

  it('`ntp peer` est rendu comme un pair, pas comme un serveur', async () => {
    const r = new CiscoRouter(`P${++serie}`);
    await conf(r, 'ntp peer 10.0.12.2');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('ntp peer 10.0.12.2');
    expect(cfg).not.toContain('ntp server 10.0.12.2');
  });
});

describe('§3.6 — authentification MD5', () => {
  it('la clé garde sa casse, de la saisie a la configuration rendue', async () => {
    // Le defaut le plus grave du lot : la commande entiere etait mise en
    // minuscules pour comparer ses mots-cles, et la CLE sortait de la.
    // Une configuration rejouee a l'import fabriquait donc une clé
    // differente de celle qui avait ete tapee.
    const r = new CiscoRouter(`A${++serie}`);
    await conf(r, 'ntp authenticate',
      'ntp authentication-key 1 md5 ClefNTP2024Secret', 'ntp trusted-key 1');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('ntp authentication-key 1 md5 ClefNTP2024Secret');
    expect(cfg).not.toContain('clefntp2024secret');
    expect(cfg).toContain('ntp authenticate');
    expect(cfg).toContain('ntp trusted-key 1');
  });

  it('`ntp source Loopback0` garde sa casse aussi', async () => {
    const r = new CiscoRouter(`S${++serie}`);
    await conf(r, 'ntp source Loopback0');
    expect(await r.executeCommand('show running-config')).toContain('ntp source Loopback0');
  });

  it('`show ntp authentication-keys` est une vue A SOI', async () => {
    // Elle rendait le tableau des associations, comme tout ce qui
    // suivait `show ntp`.
    const r = new CiscoRouter(`K${++serie}`);
    await conf(r, 'ntp authentication-key 1 md5 ClefNTP2024Secret');
    const v = await r.executeCommand('show ntp authentication-keys');
    expect(v).toContain('ClefNTP2024Secret');
    expect(v).not.toContain('ref clock');
  });

  it('`ntp server X key 1` associe la clé au serveur', async () => {
    const r = new CiscoRouter(`KS${++serie}`);
    await conf(r, 'ntp authentication-key 1 md5 Secret1', 'ntp trusted-key 1',
      'ntp server 192.168.100.5 key 1');
    expect(await r.executeCommand('show running-config'))
      .toContain('ntp server 192.168.100.5 key 1');
  });

  it('`no` retire ce que la commande avait pose', async () => {
    const r = new CiscoRouter(`N${++serie}`);
    await conf(r, 'ntp authenticate', 'ntp authentication-key 1 md5 Secret1',
      'ntp trusted-key 1', 'ntp source Loopback0');
    await conf(r, 'no ntp authenticate', 'no ntp authentication-key 1',
      'no ntp trusted-key 1', 'no ntp source');
    const cfg = await r.executeCommand('show running-config');
    for (const absent of ['ntp authenticate', 'ntp authentication-key',
      'ntp trusted-key', 'ntp source']) {
      expect(cfg, absent).not.toContain(absent);
    }
  });
});

describe('§3.7 — controle d\'acces NTP', () => {
  it('les quatre familles d\'`access-group` se relisent', async () => {
    // Lot N6 : ce cas suivait le tutoriel, qui ecrit `ntp access-group
    // nomodify 10`. Verification faite contre la reference de commandes
    // IOS, `nomodify` n'est PAS un mot-cle Cisco — c'est celui de
    // `ntpd`/`chrony`. Les quatre familles d'IOS sont `peer`, `serve`,
    // `serve-only` et `query-only`, et `nomodify` est refuse.
    const r = new CiscoRouter(`AG${++serie}`);
    await conf(r, 'access-list 10 permit 192.168.100.0 0.0.0.255',
      'ntp access-group serve-only 10', 'ntp access-group peer 10',
      'ntp access-group query-only 10', 'ntp access-group serve 10');
    const cfg = await r.executeCommand('show running-config');
    for (const k of ['serve-only', 'peer', 'query-only', 'serve']) {
      expect(cfg, k).toContain(`ntp access-group ${k} 10`);
    }
  });
});

describe('§3.8 — la vue de statut porte de quoi diagnostiquer', () => {
  it('les huit lignes du bloc IOS sont la', async () => {
    const srv = await serveur();
    const r = await client(srv);
    await conf(r, 'ntp server 192.168.100.5 prefer');
    const st = await r.executeCommand('show ntp status');
    for (const attendu of ['Clock is synchronized', 'nominal freq is',
      'ntp uptime is', 'reference time is', 'clock offset is', 'root delay is',
      'root dispersion is', 'peer dispersion is', 'loopfilter state is',
      'system poll interval is', 'last update was']) {
      expect(st, attendu).toContain(attendu);
    }
  });

  it('une machine non synchronisee le dit, et sans source', async () => {
    const r = new CiscoRouter(`U${++serie}`);
    const st = await r.executeCommand('show ntp status');
    expect(st).toMatch(/^Clock is unsynchronized, stratum 16, no reference clock/);
    expect(st).toContain("loopfilter state is 'FSET'");
  });

  it('`show ntp associations detail` existe et porte les filtres', async () => {
    const srv = await serveur();
    const r = await client(srv);
    await conf(r, 'ntp server 192.168.100.5 prefer');
    const d = await r.executeCommand('show ntp associations detail');
    expect(d).toContain('192.168.100.5 configured, our_master, sane, valid, stratum 2');
    expect(d).toContain('our mode client, peer mode server');
    for (const f of ['filtdelay', 'filtoffset', 'filterror']) {
      expect(d, f).toContain(f);
      // Huit mesures, comme IOS.
      const l = ligne(d, f);
      expect(l.split('=')[1].trim().split(/\s+/).length, l).toBe(8);
    }
  });

  it('chaque sous-commande de `show ntp` est une vue distincte', async () => {
    const srv = await serveur();
    const r = await client(srv);
    await conf(r, 'ntp server 192.168.100.5', 'ntp authentication-key 1 md5 Secret1');
    const vues = await Promise.all(['show ntp status', 'show ntp associations',
      'show ntp associations detail', 'show ntp authentication-keys']
      .map((v) => r.executeCommand(v)));
    // Aucune ne repete une autre : c'est exactement ce que le greedy
    // faisait, en rendant le tableau pour les quatre.
    expect(new Set(vues).size).toBe(4);
  });

  it('une sous-commande qui n\'existe pas est refusee', async () => {
    const r = new CiscoRouter(`I${++serie}`);
    expect(await r.executeCommand('show ntp packets')).toMatch(/% Invalid input detected/);
  });
});

describe('§9 — durcissement', () => {
  it('`ntp disable` sur une interface est acceptee ET rejouable', async () => {
    const r = new CiscoRouter(`D${++serie}`);
    const [sortie] = await conf(r, 'interface GigabitEthernet0/0', 'ntp disable');
    expect(sortie).not.toMatch(/Invalid input/);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain(' ntp disable');
    expect(r.getNtpAgent().isInterfaceDisabled('GigabitEthernet0/0')).toBe(true);
  });

  it('`no ntp disable` la retire', async () => {
    const r = new CiscoRouter(`D${++serie}`);
    await conf(r, 'interface GigabitEthernet0/0', 'ntp disable');
    await conf(r, 'interface GigabitEthernet0/0', 'no ntp disable');
    expect(r.getNtpAgent().isInterfaceDisabled('GigabitEthernet0/0')).toBe(false);
    expect(await r.executeCommand('show running-config')).not.toContain(' ntp disable');
  });

  it('`no ntp allow mode control` ferme le mode 6 et se relit', async () => {
    // CVE-2013-5211 : c'est le mode que `monlist` emprunte. La commande
    // etait acceptee et rangee nulle part, donc une machine durcie
    // revenait ouverte au premier import de topologie.
    const r = new CiscoRouter(`C${++serie}`);
    await conf(r, 'no ntp allow mode control');
    expect(r.getNtpAgent().getConfig().allowModeControl).toBe(false);
    expect(await r.executeCommand('show running-config')).toContain('no ntp allow mode control');
    await conf(r, 'ntp allow mode control');
    expect(r.getNtpAgent().getConfig().allowModeControl).toBe(true);
  });

  it('`ntp update-calendar` se relit', async () => {
    const r = new CiscoRouter(`UC${++serie}`);
    await conf(r, 'ntp update-calendar');
    expect(await r.executeCommand('show running-config')).toContain('ntp update-calendar');
  });
});

describe('la configuration rendue REFAIT la machine', () => {
  it('rejouer ce que la machine rend redonne le meme etat', async () => {
    // C'est la propriete qui compte pour un tutoriel : ce que le lecteur
    // copie doit reconstruire ce qu'il avait.
    const srv = await serveur();
    const source = await client(srv, '192.168.100.9');
    await conf(source, 'ntp server 192.168.100.5 prefer', 'ntp source Loopback0',
      'ntp authenticate', 'ntp authentication-key 1 md5 ClefNTP2024Secret',
      'ntp trusted-key 1', 'ntp update-calendar', 'no ntp allow mode control',
      'ntp access-group serve-only 10');
    const lignesNtp = (await source.executeCommand('show running-config'))
      .split('\n').filter((l) => l.trim().startsWith('ntp ') || l.trim().startsWith('no ntp '))
      .map((l) => l.trim());
    expect(lignesNtp.length).toBeGreaterThan(5);

    const cible = new CiscoRouter(`RJ${++serie}`);
    await conf(cible, ...lignesNtp);
    const refaites = (await cible.executeCommand('show running-config'))
      .split('\n').filter((l) => l.trim().startsWith('ntp ') || l.trim().startsWith('no ntp '))
      .map((l) => l.trim());
    expect(refaites).toEqual(lignesNtp);
  });
});
