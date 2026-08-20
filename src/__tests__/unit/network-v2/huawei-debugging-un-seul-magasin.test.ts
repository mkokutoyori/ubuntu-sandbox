/**
 * PRD-CLI-Fidelite-VRP.md §14 / lot V6 — `debugging` VRP.
 *
 * Quatre proprietes, chacune tombee d'une mesure :
 *
 * 1. UN SEUL MAGASIN. `undo debugging all` eteignait ce qu'il voyait et
 *    laissait le reste allume, en annoncant un compte faux.
 * 2. UNE SEULE DESIGNATION. Ce que la confirmation nomme est ce que
 *    `display debugging` liste, et un sujet n'a qu'une ecriture.
 * 3. CE QUI EST ACCEPTE PEUT EMETTRE. Une categorie sans source est
 *    refusee en nommant ce qui manque, plutot qu'acceptee en silence.
 * 4. LES DEUX PLATEFORMES ET LES DEUX VUES repondent pareil.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  HUAWEI_DEBUG_CATALOG,
  HUAWEI_DEBUG_SANS_SOURCE,
} from '@/network/devices/router/diag/huaweiDebugCatalog';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;
interface Cli { executeCommand(c: string): Promise<string> }

async function dans(fabrique: () => Cli, vue: readonly string[] = []): Promise<Cli> {
  const d = fabrique();
  for (const c of vue) await d.executeCommand(c);
  return d;
}
const R = () => new HuaweiRouter(`DB${++serie}`) as unknown as Cli;
const S = () => new HuaweiSwitch(`DC${++serie}`) as unknown as Cli;

const REFUS = /^Error: (Wrong parameter|Incomplete command|Unrecognized command|Too many parameters) found at '\^' position\./;

describe('un seul magasin', () => {
  it('`undo debugging all` eteint TOUT, y compris les sous-moteurs', async () => {
    const r = await dans(R, ['system-view', 'dhcp enable', 'quit']);
    await r.executeCommand('debugging ospf event');
    await r.executeCommand('debugging ip icmp');
    await r.executeCommand('debugging dhcp server packet');
    await r.executeCommand('debugging ike');

    const avant = await r.executeCommand('display debugging');
    expect(avant).toContain('OSPF event');
    expect(avant).toContain('ip icmp');
    expect(avant).toContain('DHCP server packet');
    expect(avant).toContain('IKE');

    await r.executeCommand('undo debugging all');
    expect(await r.executeCommand('display debugging')).toBe('No debugging is on');
  });

  it('le compte annonce est le nombre reellement eteint', async () => {
    const r = await dans(R);
    expect(await r.executeCommand('undo debugging all'))
      .toBe('Info: All possible debugging functions are off.');
    await r.executeCommand('debugging ospf event');
    await r.executeCommand('debugging ip packet');
    expect(await r.executeCommand('undo debugging all'))
      .toBe('Info: 2 debugging switch(es) have been turned off.');
  });

  it('une extinction ciblee ne touche que sa categorie', async () => {
    const r = await dans(R);
    await r.executeCommand('debugging ospf event');
    await r.executeCommand('debugging ip packet');
    await r.executeCommand('undo debugging ospf event');
    const reste = await r.executeCommand('display debugging');
    expect(reste).toContain('IP packet debugging is on');
    expect(reste).not.toContain('OSPF event');
  });

  it('aucun second magasin ne subsiste dans le code', () => {
    const shell = readFileSync('src/network/devices/shells/HuaweiVRPShell.ts', 'utf8');
    const vues = readFileSync('src/network/devices/shells/huawei/HuaweiDisplayCommands.ts', 'utf8');
    expect(shell).not.toContain('_huaweiDebugFlags');
    expect(vues).not.toContain('_huaweiDebugFlags');
  });
});

describe('une seule designation', () => {
  it('ce que la confirmation nomme est ce que la vue liste', async () => {
    for (const spec of HUAWEI_DEBUG_CATALOG.filter((s) => s.platforms.includes('router'))) {
      const r = await dans(R);
      const ecrit = spec.words.join(' ');
      const confirmation = await r.executeCommand(`debugging ${ecrit}`);
      expect(confirmation, ecrit).toBe(`Info: ${spec.label} debugging is on.`);
      expect(await r.executeCommand('display debugging'), ecrit)
        .toBe(`${spec.label} debugging is on`);
      expect(await r.executeCommand(`undo debugging ${ecrit}`), ecrit)
        .toBe(`Info: ${spec.label} debugging is off.`);
    }
  });

  it('un sujet n\'a qu\'une ecriture : la seconde a disparu', async () => {
    // `debugging icmp` rangeait dans un magasin, `debugging ip icmp`
    // dans l'autre, et `display debugging` montrait les DEUX pour un
    // seul sujet. `ip icmp` est l'ecriture de VRP ; l'autre n'existe plus.
    const r = await dans(R);
    expect(await r.executeCommand('debugging icmp')).toMatch(REFUS);
    expect(await r.executeCommand('display debugging')).toBe('No debugging is on');
  });

  it('`display debug` et `display debugging` sont la MEME commande', async () => {
    const r = await dans(R);
    await r.executeCommand('debugging ip packet');
    expect(await r.executeCommand('display debug'))
      .toBe(await r.executeCommand('display debugging'));
  });
});

describe('ce qui est accepte peut emettre', () => {
  const SERVICE = 'src/network/devices/router/diag/HuaweiDebugService.ts';

  it('toute categorie du catalogue est emise quelque part', () => {
    const src = readFileSync(SERVICE, 'utf8');
    const emises = new Set(
      [...src.matchAll(/this\.emit\('([a-z0-9-]+)'/g)].map((m) => m[1]),
    );
    const orphelines = HUAWEI_DEBUG_CATALOG
      .map((s) => s.category)
      .filter((c) => !emises.has(c));
    expect(orphelines).toEqual([]);
  });

  it('un module que rien ne trace est refuse en le nommant', async () => {
    for (const sans of HUAWEI_DEBUG_SANS_SOURCE) {
      const r = await dans(R);
      const out = await r.executeCommand(`debugging ${sans.words.join(' ')}`);
      expect(out).toBe(`Error: ${sans.raison}`);
      expect(await r.executeCommand('display debugging')).toBe('No debugging is on');
    }
  });

  it('un mot inconnu est refuse a la forme de VRP', async () => {
    for (const c of ['debugging zzz', 'debugging all', 'debugging ospf zzz']) {
      const r = await dans(R);
      const out = await r.executeCommand(c);
      expect(out, c).toMatch(REFUS);
      expect(out.split('\n').length, c).toBe(3);
      expect(out.split('\n')[1], c).toBe(c);
    }
  });

  it('`debugging` seul est incomplet, il ne vaut pas `all`', async () => {
    const r = await dans(R);
    const out = await r.executeCommand('debugging');
    expect(out).toContain("Error: Incomplete command found at '^' position.");
    expect(await r.executeCommand('display debugging')).toBe('No debugging is on');
  });

  it('une trace ICMP arrive vraiment, et nomme l\'interface comme les vues', async () => {
    const r1 = new HuaweiRouter(`E${++serie}`);
    const r2 = new HuaweiRouter(`E${++serie}`);
    new Cable('cx').connect(r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);
    let n = 1;
    for (const d of [r1, r2]) {
      await d.executeCommand('system-view');
      await d.executeCommand('interface GigabitEthernet0/0/0');
      await d.executeCommand(`ip address 10.0.12.${n++} 255.255.255.0`);
      await d.executeCommand('quit');
      await d.executeCommand('quit');
    }
    const recu: string[] = [];
    r1.getHuaweiDebugService().subscribe((l) => recu.push(l));
    await r1.executeCommand('debugging ip icmp');
    await r1.executeCommand('ping -c 1 10.0.12.2');
    expect(recu.some((l) => l.startsWith('ICMP: Echo Request'))).toBe(true);
    expect(recu.some((l) => l.startsWith('ICMP: Echo Reply'))).toBe(true);
  });

  it('une trace OSPF nomme l\'interface en toutes lettres', async () => {
    const r1 = new HuaweiRouter(`F${++serie}`);
    const r2 = new HuaweiRouter(`F${++serie}`);
    new Cable('cy').connect(r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);
    let n = 1;
    for (const d of [r1, r2]) {
      await d.executeCommand('system-view');
      await d.executeCommand('interface GigabitEthernet0/0/0');
      await d.executeCommand(`ip address 10.0.13.${n++} 255.255.255.0`);
      await d.executeCommand('quit');
      await d.executeCommand('ospf 1');
      await d.executeCommand('area 0');
      await d.executeCommand('network 10.0.13.0 0.0.0.255');
      await d.executeCommand('quit');
      await d.executeCommand('quit');
      await d.executeCommand('quit');
    }
    const recu: string[] = [];
    r1.getHuaweiDebugService().subscribe((l) => recu.push(l));
    await r1.executeCommand('debugging ospf event');
    await r1.executeCommand('debugging ospf hello');
    await r1.executeCommand('system-view');
    await r1.executeCommand('interface GigabitEthernet0/0/0');
    await r1.executeCommand('shutdown');
    await r1.executeCommand('undo shutdown');
    expect(recu.length).toBeGreaterThan(0);
    expect(recu.some((l) => l.includes('GigabitEthernet0/0/0'))).toBe(true);
    expect(recu.some((l) => /\bGE0\/0\/0\b/.test(l))).toBe(false);
  });
});

describe('les deux vues, les deux plateformes', () => {
  it('la meme commande repond pareil en vue utilisateur et en vue systeme', async () => {
    for (const spec of HUAWEI_DEBUG_CATALOG.filter((s) => s.platforms.includes('router'))) {
      const ecrit = `debugging ${spec.words.join(' ')}`;
      const utilisateur = await (await dans(R)).executeCommand(ecrit);
      const systeme = await (await dans(R, ['system-view'])).executeCommand(ecrit);
      expect(systeme, ecrit).toBe(utilisateur);
    }
  });

  it('le switch a le meme magasin, et sait dire ce qui est allume', async () => {
    const s = await dans(S);
    expect(await s.executeCommand('display debugging')).toBe('No debugging is on');
    expect(await s.executeCommand('debugging stp')).toBe('Info: STP debugging is on.');
    expect(await s.executeCommand('display debugging')).toBe('STP debugging is on');
    expect(await s.executeCommand('undo debugging all'))
      .toBe('Info: 1 debugging switch(es) have been turned off.');
    expect(await s.executeCommand('display debugging')).toBe('No debugging is on');
  });

  it('une categorie d\'une autre plateforme est refusee, pas rangee', async () => {
    const s = await dans(S);
    for (const c of ['debugging vrrp', 'debugging rip', 'debugging bgp']) {
      expect(await s.executeCommand(c), c).toMatch(REFUS);
    }
    expect(await s.executeCommand('display debugging')).toBe('No debugging is on');

    const r = await dans(R);
    expect(await r.executeCommand('debugging stp')).toMatch(REFUS);
  });

  it('ce que les deux plateformes partagent, elles le disent pareil', async () => {
    for (const ecrit of ['ip icmp', 'ip packet', 'ospf event', 'arp packet']) {
      const r = await dans(R);
      const s = await dans(S);
      expect(await s.executeCommand(`debugging ${ecrit}`), ecrit)
        .toBe(await r.executeCommand(`debugging ${ecrit}`));
      expect(await s.executeCommand('display debugging'), ecrit)
        .toBe(await r.executeCommand('display debugging'));
    }
  });
});
