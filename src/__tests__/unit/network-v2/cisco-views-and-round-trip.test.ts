/**
 * PRD-Routage-Fidelite.md chantier D / lot R6 — les vues et les messages.
 *
 * Trois proprietes, pas trois listes de chaines :
 *
 * 1. Une configuration acceptee se relit. C'est le test n°1 du §6, et
 *    c'est ce qui compte le plus ici : la running-config n'est pas un
 *    affichage, c'est le texte que l'import de topologie REJOUE.
 * 2. Une vue filtree ne repond que sur ce qu'on lui a demande.
 * 3. Un en-tete surmonte la colonne qu'il nomme — verifie en comparant
 *    les positions, jamais en figeant une chaine espace par espace.
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

async function run(dev: CiscoRouter, cmds: string[]): Promise<void> {
  for (const c of cmds) await dev.executeCommand(c);
}

/** La colonne ou commence `mot` dans `ligne`, ou -1. */
function colonne(ligne: string, mot: string): number {
  const re = new RegExp(`(^|\\s)${mot.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\s|$)`);
  const m = re.exec(ligne);
  return m ? m.index + (m[1] ? m[1].length : 0) : -1;
}

async function labo(): Promise<{ a: CiscoRouter; b: CiscoRouter }> {
  const a = new CiscoRouter(`WA${++serie}`);
  const b = new CiscoRouter(`WB${serie}`);
  new Cable(`wc${serie}`).connect(a.getPorts()[0], b.getPorts()[0]);
  for (const [d, n] of [[a, '1'], [b, '2']] as const) {
    await run(d, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address 10.0.12.${n} 255.255.255.0`, 'no shutdown', 'exit',
      'ip multicast-routing',
      'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0', 'exit',
      'interface GigabitEthernet0/0', 'ip pim sparse-mode', 'exit',
      'ip route 172.16.0.0 255.255.0.0 10.0.12.9', 'end',
    ]);
  }
  return { a, b };
}

describe('une configuration IPv6 acceptee se relit', () => {
  const POSEES = [
    'ipv6 address fe80::1 link-local',
    'ipv6 address 2001:db8::1/64',
    'ipv6 address 2001:db8:2::1/64',
  ];

  it('chaque ligne tapee revient dans la running-config', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/1', ...POSEES, 'end']);
    const conf = await a.executeCommand('show running-config');
    for (const l of POSEES) expect(conf, l).toContain(` ${l}`);
  });

  it('elle revient dans le BLOC de son interface, pas ailleurs', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/1', ...POSEES, 'end']);
    const bloc = await a.executeCommand('show running-config | section interface GigabitEthernet0/1');
    for (const l of POSEES) expect(bloc, l).toContain(` ${l}`);
  });

  it('un routeur qui rejoue cette configuration porte les memes adresses', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/1', ...POSEES, 'end']);
    const adresses = (t: string) => (t.split('GigabitEthernet0/1')[1] ?? '')
      .split('GigabitEthernet0/2')[0].trim();
    const avant = adresses(await a.executeCommand('show ipv6 interface brief'));
    expect(avant).toContain('fe80::1');

    const neuf = new CiscoRouter(`WR${++serie}`);
    await run(neuf, ['enable', 'configure terminal', 'interface GigabitEthernet0/1', ...POSEES, 'end']);
    expect(adresses(await neuf.executeCommand('show ipv6 interface brief'))).toBe(avant);
  });

  it('`ipv6 enable` derive son adresse de lien au lieu de n\'en avoir aucune', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/2', 'ipv6 enable', 'end']);
    expect(await a.executeCommand('show running-config | section interface GigabitEthernet0/2'))
      .toContain(' ipv6 enable');
    const brief = await a.executeCommand('show ipv6 interface brief');
    const bloc = brief.split('GigabitEthernet0/2')[1] ?? '';
    expect(bloc.split('GigabitEthernet0/3')[0]).toMatch(/fe80::/);
  });

  it('une adresse de lien posee a la main EST une adresse de lien', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/1',
      'ipv6 address fe80::1 link-local', 'end']);
    const port = a.getPort('GigabitEthernet0/1')!;
    expect(port.getLinkLocalIPv6()?.toString()).toContain('fe80::1');
    expect(port.getIPv6Addresses().map((e) => e.origin)).toContain('link-local');
  });

  it('elle est rendue sans zone ni longueur de prefixe', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'interface GigabitEthernet0/1',
      'ipv6 address fe80::1 link-local', 'end']);
    for (const vue of [
      await a.executeCommand('show ipv6 interface brief'),
      await a.executeCommand('show running-config'),
    ]) {
      expect(vue).toMatch(/fe80::1(?![%/\w])/);
      expect(vue).not.toMatch(/fe80::1%/);
      expect(vue).not.toMatch(/fe80::1\/64/);
    }
  });
});

describe('une vue filtree ne repond que sur ce qu\'on lui a demande', () => {
  it('`show ip cef <prefixe>` ne rend que ce prefixe', async () => {
    const { a } = await labo();
    const complet = (await a.executeCommand('show ip cef')).split('\n');
    expect(complet.length).toBeGreaterThan(2);

    for (const [arg, attendu] of [
      ['172.16.0.0', '172.16.0.0/16'],
      ['10.0.12.0', '10.0.12.0/24'],
    ] as const) {
      const lignes = (await a.executeCommand(`show ip cef ${arg}`)).split('\n').slice(1);
      expect(lignes.length, arg).toBe(1);
      expect(lignes[0], arg).toContain(attendu);
    }
  });

  it('la ligne `0.0.0.0/0 no route` decrit la table, donc elle ne traverse pas le filtre', async () => {
    const { a } = await labo();
    expect(await a.executeCommand('show ip cef')).toContain('0.0.0.0/0            no route');
    expect(await a.executeCommand('show ip cef 172.16.0.0')).not.toContain('no route');
  });

  it('un prefixe absent de la FIB ne rend que l\'en-tete', async () => {
    const { a } = await labo();
    const out = await a.executeCommand('show ip cef 203.0.113.0');
    expect(out.split('\n').length).toBe(1);
    expect(out).toContain('Prefix');
  });
});

describe('un en-tete surmonte la colonne qu\'il nomme', () => {
  it('`show ip pim interface` aligne ses deux lignes d\'en-tete sur ses donnees', async () => {
    const { a } = await labo();
    const [h1, h2, data] = (await a.executeCommand('show ip pim interface')).split('\n');
    expect(data).toContain('GigabitEthernet0/0');

    expect(colonne(h2, 'Count')).toBe(colonne(h1, 'Nbr'));
    expect(colonne(h2, 'Intvl')).toBe(colonne(h1, 'Query'));
    for (const [entete, valeur] of [
      [colonne(h1, 'Address'), colonne(data, '10.0.12.1')],
      [colonne(h1, 'Interface'), colonne(data, 'GigabitEthernet0/0')],
      [colonne(h2, 'Count'), colonne(data, '1')],
      [colonne(h2, 'Intvl'), colonne(data, '30')],
    ] as const) {
      expect(entete).toBeGreaterThanOrEqual(0);
      expect(valeur).toBe(entete);
    }
  });

  it('`show ip ospf interface brief` aligne `Nbrs F/C` sur son compte', async () => {
    const { a } = await labo();
    const [entete, ...rows] = (await a.executeCommand('show ip ospf interface brief')).split('\n');
    const ligne = rows.find((l) => l.startsWith('Gi0/0'))!;
    expect(colonne(ligne, 'DR')).toBe(colonne(entete, 'State'));
    expect(colonne(ligne, '1/1')).toBe(colonne(entete, 'Nbrs'));
  });
});

describe('ce que la mesure a trouve deja correct reste correct', () => {
  it('aucune commande sans prefixe ne repond `% Network not in table`', async () => {
    const { a } = await labo();
    for (const c of [
      'show ip nat translations', 'show ip nat statistics', 'show ip mroute',
      'show ip pim neighbor', 'show ip igmp groups', 'show ip protocols',
      'show ip rip database', 'show ip ospf neighbor', 'show ip ospf database',
      'show ip cef', 'show ip arp', 'show ip route summary', 'show ip policy',
      'show ip nhrp', 'show ip sla summary',
    ]) {
      expect(await a.executeCommand(c), c).not.toContain('Network not in table');
    }
  });

  it('un identifiant de processus OSPF inexistant rend le vide, pas la sortie complete', async () => {
    const { a } = await labo();
    const reel = await a.executeCommand('show ip ospf 1');
    expect(reel).toContain('Routing Process');
    for (const c of ['show ip ospf 99', 'show ip ospf 99 interface',
      'show ip ospf 99 neighbor', 'show ip ospf 99 database']) {
      expect((await a.executeCommand(c)).trim(), c).toBe('');
    }
  });

  it('`show ip route connected|static` porte la legende entiere', async () => {
    const { a } = await labo();
    const legende = (await a.executeCommand('show ip route')).split('\n\n')[0];
    expect(legende.split('\n').length).toBeGreaterThan(5);
    for (const c of ['show ip route connected', 'show ip route static']) {
      expect((await a.executeCommand(c)).split('\n\n')[0], c).toBe(legende);
    }
  });

  it('`show ip rip database` lit `auto-summary` de la configuration', async () => {
    const { a } = await labo();
    await run(a, ['configure terminal', 'router rip', 'version 2', 'network 10.0.0.0', 'end']);
    expect(await a.executeCommand('show ip rip database')).toContain('auto-summary');
    await run(a, ['configure terminal', 'router rip', 'no auto-summary', 'end']);
    expect(await a.executeCommand('show ip rip database')).not.toContain('auto-summary');
  });
});
