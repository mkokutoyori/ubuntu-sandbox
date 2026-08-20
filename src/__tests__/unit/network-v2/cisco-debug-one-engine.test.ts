/**
 * PRD-Debug-Fidelite-Cisco.md §6 / §7.6 — un seul moteur.
 *
 * Une machine Cisco a UN sous-systeme de debug. Le routeur et le switch
 * en partagent le moteur et ne different que par les categories que leur
 * plateforme connait. Ce qui est verifie ici n'est donc pas une liste de
 * messages mais une propriete : pour une commande que les deux
 * plateformes connaissent, elles repondent le meme mot, et pour une
 * commande qu'une seule connait, l'autre la refuse au lieu d'armer un
 * drapeau que rien n'alimentera.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { RouterDebugService, categoryOnPlatform, debugCategoriesFor } from '@/network/devices/router/diag/RouterDebugService';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serial = 0;

interface AvecDebug { getDebugService(): RouterDebugService }

async function routeur(): Promise<CiscoRouter> {
  const r = new CiscoRouter(`E1R${++serial}`);
  await r.executeCommand('enable');
  return r;
}

async function commutateur(): Promise<CiscoSwitch> {
  const s = new CiscoSwitch('switch-cisco', `E1S${++serial}`);
  await s.executeCommand('enable');
  return s;
}

/** Les commandes que les DEUX plateformes connaissent. */
const PARTAGEES = [
  'debug cdp',
  'debug lldp',
  'debug ip arp',
  'debug ip dhcp server',
  'debug interface',
];

/** Ce que seul un switch sait faire. */
const SWITCH_SEUL = [
  'debug spanning-tree',
  'debug spanning-tree bpdu',
  'debug mac address-table',
  'debug link-state',
  'debug port-security',
];

/** Ce que seul un routeur sait faire. */
const ROUTEUR_SEUL = [
  'debug ip packet',
  'debug ip ospf adj',
  'debug ip bgp',
  'debug ip routing',
  'debug standby',
  'debug crypto isakmp',
];

describe('les deux plateformes partagent le moteur', () => {
  it('le switch et le routeur portent la MEME classe de service', async () => {
    const r = await routeur();
    const s = await commutateur();
    const sr = (r as unknown as AvecDebug).getDebugService();
    const ss = (s as unknown as AvecDebug).getDebugService();
    expect(sr).toBeInstanceOf(RouterDebugService);
    expect(ss).toBeInstanceOf(RouterDebugService);
    expect(ss.constructor).toBe(sr.constructor);
  });

  it('il n\'existe plus de second moteur pour le switch', () => {
    expect(existsSync(resolve(process.cwd(), 'src/network/devices/switch/SwitchDebugService.ts'))).toBe(false);
  });

  it('un service est le sien : armer sur l\'un ne touche pas l\'autre', async () => {
    const a = await commutateur();
    const b = await commutateur();
    await a.executeCommand('debug spanning-tree');
    expect(await b.executeCommand('show debugging')).toBe('No debug flags are enabled');
  });
});

describe('une commande partagee dit le meme mot des deux cotes', () => {
  it('l\'armement, le desarmement et le registre vide sont mot pour mot les memes', async () => {
    const r = await routeur();
    const s = await commutateur();
    expect(await r.executeCommand('show debugging')).toBe(await s.executeCommand('show debugging'));
    for (const c of PARTAGEES) {
      const surR = await r.executeCommand(c);
      const surS = await s.executeCommand(c);
      expect(surS, c).toBe(surR);
      expect(surR, c).toMatch(/debugging is on$/);

      const offR = await r.executeCommand(`no ${c}`);
      const offS = await s.executeCommand(`no ${c}`);
      expect(offS, c).toBe(offR);
      expect(offR, c).toMatch(/debugging is off$/);
    }
  });

  it('`undebug all` et `show debugging` ne dependent pas de la plateforme', async () => {
    const r = await routeur();
    const s = await commutateur();
    for (const d of [r, s]) {
      await d.executeCommand('debug cdp');
      await d.executeCommand('debug lldp');
    }
    const surR = await r.executeCommand('undebug all');
    const surS = await s.executeCommand('undebug all');
    expect(surS).toBe(surR);
    expect(surR).toBe('All possible debugging has been turned off');
    expect(await s.executeCommand('undebug all')).toBe(surR);
    expect(await s.executeCommand('show debugging')).toBe(await r.executeCommand('show debugging'));
    expect(await s.executeCommand('show debugging')).toBe('No debug flags are enabled');
  });
});

describe('chaque plateforme refuse ce qu\'elle ne sait pas faire', () => {
  it('le routeur refuse les categories de commutation, sans rien armer', async () => {
    const r = await routeur();
    for (const c of SWITCH_SEUL) {
      expect(await r.executeCommand(c), c).toMatch(/Invalid input/);
      expect(await r.executeCommand('show debugging'), c).toBe('No debug flags are enabled');
    }
  });

  it('le switch refuse les categories de routage, sans rien armer', async () => {
    const s = await commutateur();
    for (const c of ROUTEUR_SEUL) {
      expect(await s.executeCommand(c), c).toMatch(/Invalid input/);
      expect(await s.executeCommand('show debugging'), c).toBe('No debug flags are enabled');
    }
  });

  it('un refus est un refus de mot-cle, pas une panne de service', async () => {
    const s = await commutateur();
    expect(await s.executeCommand('debug ip ospf adj')).not.toMatch(/OSPF is not enabled|not supported|error/i);
    await s.executeCommand('debug spanning-tree');
    expect(await s.executeCommand('show debugging')).toMatch(/Spanning Tree event debugging is on/);
  });
});

describe('`debug all` n\'arme que ce que la plateforme connait', () => {
  it('le switch n\'arme aucune categorie de routage', async () => {
    const s = await commutateur();
    expect(await s.executeCommand('debug all')).toBe('All possible debugging has been turned on');
    const vu = await s.executeCommand('show debugging');
    expect(vu).toMatch(/Spanning Tree event debugging is on/);
    expect(vu).toMatch(/MAC address table debugging is on/);
    expect(vu).not.toMatch(/OSPF|BGP|HSRP|Crypto|IP SLA|IP packet|PIM/);
  });

  it('le routeur n\'arme aucune categorie de commutation', async () => {
    const r = await routeur();
    expect(await r.executeCommand('debug all')).toBe('All possible debugging has been turned on');
    const vu = await r.executeCommand('show debugging');
    expect(vu).toMatch(/IP packet debugging is on/);
    expect(vu).not.toMatch(/Spanning Tree|MAC address table|Link state/);
  });

  it('tout ce que `debug all` arme est une categorie de la plateforme', async () => {
    for (const [dev, plat] of [[await routeur(), 'router'], [await commutateur(), 'switch']] as const) {
      await dev.executeCommand('debug all');
      const svc = (dev as unknown as AvecDebug).getDebugService();
      expect(svc.list().length, plat).toBeGreaterThan(0);
      for (const f of svc.list()) {
        expect(categoryOnPlatform(f.category, plat), `${plat}/${f.category}`).toBe(true);
      }
    }
  });
});

describe('une famille se desarme comme famille', () => {
  it('`no debug spanning-tree` eteint les deux drapeaux d\'un coup', async () => {
    const s = await commutateur();
    await s.executeCommand('debug spanning-tree');
    await s.executeCommand('debug spanning-tree bpdu');
    expect(await s.executeCommand('show debugging')).toMatch(/BPDU debugging is on/);
    expect(await s.executeCommand('no debug spanning-tree')).toMatch(/Spanning Tree.* debugging is off/);
    expect(await s.executeCommand('show debugging')).toBe('No debug flags are enabled');
  });
});

describe('une seule table traduit le mot de l\'operateur', () => {
  it('les alias rendent la meme categorie quelle que soit l\'orthographe', () => {
    expect(debugCategoriesFor('mac')).toEqual(debugCategoriesFor('mac address-table'));
    expect(debugCategoriesFor('link')).toEqual(debugCategoriesFor('link-state'));
    expect(debugCategoriesFor('arp')).toEqual(debugCategoriesFor('ip.arp'));
    expect(debugCategoriesFor('spanning-tree')).toEqual(['stp.events', 'stp.bpdu']);
    expect(debugCategoriesFor('spanning-tree bpdu')).toEqual(['stp.bpdu']);
  });

  it('un mot inconnu ne rend aucune categorie', () => {
    for (const w of ['', 'zzz', 'ospf zzz', 'nonsense']) {
      expect(debugCategoriesFor(w), w).toBeNull();
    }
  });

  it('les deux plateformes lisent la table, chacune la sienne', async () => {
    const s = (await commutateur() as unknown as AvecDebug).getDebugService();
    const r = (await routeur() as unknown as AvecDebug).getDebugService();
    expect(s.recognizes('spanning-tree')).toBe(true);
    expect(r.recognizes('spanning-tree')).toBe(false);
    expect(s.recognizes('mac')).toBe(true);
    expect(r.recognizes('mac')).toBe(false);
    expect(s.recognizes('cdp')).toBe(true);
    expect(r.recognizes('cdp')).toBe(true);
  });
});
