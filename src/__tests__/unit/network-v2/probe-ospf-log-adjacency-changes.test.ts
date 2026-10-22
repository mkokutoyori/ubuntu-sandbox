/**
 * `log-adjacency-changes [detail]` decide ce que le syslog journalise.
 *
 * Mesure de depart : `log-adjacency-changes`, `… detail` et `no
 * log-adjacency-changes` etaient lus puis sans effet sur le syslog, qui
 * journalisait toujours les seules transitions entrant dans Full ou en
 * sortant. `detail` ne changeait rien (aucune transition Init,
 * ExStart, Exchange, Loading n'etait jamais journalisee), `no
 * log-adjacency-changes` n'existait pas, et la valeur ne se rendait pas en
 * running-config. Deux magasins disaient la meme chose : un drapeau annexe
 * de la configuration Cisco (qui alimentait une ligne `Log-Adjacency-Changes:
 * enabled` de `show ip ospf` qu'aucun exemple officiel ne montre) et le
 * drapeau du moteur.
 *
 * Autorite (reference officielle seulement) : Cisco IOS IP Routing OSPF
 * Command Reference, `log-adjacency-changes` — activee par defaut ; « only
 * up/down (full/down) events are reported, unless the detail keyword is
 * also used » ; `detail` : « a syslog message for each state change, not
 * just when a neighbor goes up or down » ; forme `no log-adjacency-changes
 * [detail]`. Les exemples de configuration de la meme reference montrent
 * ` log-adjacency-changes` sous `router ospf`. Le LIBELLE de la ligne
 * %OSPF-5-ADJCHG n'est attesté par aucun document du depot : il est laisse
 * tel quel (voir TODO.md).
 *
 * Discrimination, mesuree sur le commit de base avec ce fichier copie :
 * 6 des 11 cas tombent. Passent des deux cotes cinq cas, nommes : les trois
 * TEMOINS (une seule ligne `to Full` par defaut, aucune transition
 * intermediaire par defaut, `from Full to Down` par defaut) et deux cas qui
 * ne discriminent que par ceux qui les entourent — `no … detail` revient a
 * Full / Down (sur la base `detail` n'a jamais rien change) et
 * `log-adjacency-changes` rallume (sur la base le syslog n'a jamais ete
 * eteint). Sur ces liens point a point la machine d'etats passe de Init a
 * ExStart sans 2Way, ce que prevoit la RFC 2328 §10.3 quand l'adjacence
 * doit etre etablie.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function lab(routerOspf: readonly string[]) {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.0.0.3 area 0', ...routerOspf, 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.0.0 0.0.0.3 area 0', 'end']);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  clock.advance(60_000);
  return { r1, r2 };
}

const adjacencyLines = async (router: CiscoRouter) =>
  (await router.executeCommand('show logging')).split('\n').filter(line => line.includes('%OSPF-5-ADJCHG'));

const ospfBlock = (router: CiscoRouter) => router.executeCommand('show running-config | section router ospf');

describe('par defaut : seulement entrer dans Full ou en sortir', () => {
  it('WITNESS: une ligne `to Full` quand l\'adjacence monte', async () => {
    const { r1 } = await lab([]);
    const lines = await adjacencyLines(r1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Nbr 2.2.2.2 on GigabitEthernet0/0 from Loading to Full');
  });

  it('WITNESS: aucune transition intermediaire n\'est journalisee', async () => {
    const { r1 } = await lab([]);
    const text = (await adjacencyLines(r1)).join('\n');
    for (const state of ['Init', 'ExStart', 'Exchange', 'Loading']) expect(text).not.toContain(`to ${state}`);
  });

  it('WITNESS: la chute de l\'adjacence journalise `from Full to Down`', async () => {
    const { r1, r2 } = await lab([]);
    await type(r2, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    clock.advance(60_000);
    expect((await adjacencyLines(r1)).join('\n')).toContain('from Full to Down');
  });
});

describe('detail', () => {
  it('journalise chaque changement d\'etat, pas seulement Full', async () => {
    const { r1 } = await lab(['log-adjacency-changes detail']);
    const text = (await adjacencyLines(r1)).join('\n');
    for (const state of ['Init', 'ExStart', 'Exchange', 'Loading', 'Full']) expect(text).toContain(`to ${state}`);
  });

  it('no log-adjacency-changes detail revient a Full / Down seulement', async () => {
    const { r1 } = await lab(['log-adjacency-changes detail', 'no log-adjacency-changes detail']);
    const text = (await adjacencyLines(r1)).join('\n');
    expect(text).toContain('to Full');
    expect(text).not.toContain('to Init');
  });
});

describe('no log-adjacency-changes', () => {
  it('le syslog ne dit plus rien de l\'adjacence', async () => {
    const { r1, r2 } = await lab(['no log-adjacency-changes']);
    expect(await r1.executeCommand('show ip ospf neighbor')).toContain('FULL');
    expect(await adjacencyLines(r1)).toHaveLength(0);
    await type(r2, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    clock.advance(60_000);
    expect(await adjacencyLines(r1)).toHaveLength(0);
  });

  it('log-adjacency-changes la rallume', async () => {
    const { r1 } = await lab(['no log-adjacency-changes', 'log-adjacency-changes']);
    expect(await adjacencyLines(r1)).toHaveLength(1);
  });
});

describe('running-config', () => {
  it('rend la ligne par defaut, la forme detail, et rien apres no', async () => {
    const { r1 } = await lab([]);
    expect(await ospfBlock(r1)).toMatch(/^ log-adjacency-changes$/m);
    await type(r1, ['configure terminal', 'router ospf 1', 'log-adjacency-changes detail', 'end']);
    expect(await ospfBlock(r1)).toMatch(/^ log-adjacency-changes detail$/m);
    await type(r1, ['configure terminal', 'router ospf 1', 'no log-adjacency-changes', 'end']);
    expect(await ospfBlock(r1)).not.toContain('log-adjacency-changes');
  });

  it('rejouee sur un routeur neuf, la forme detail rend le meme etat', async () => {
    const { r1 } = await lab(['log-adjacency-changes detail']);
    const rendered = await ospfBlock(r1);
    expect(rendered).toContain(' log-adjacency-changes detail');
    const lines = rendered.split('\n').filter(line => line.startsWith(' ')).map(line => line.trim());
    const replica = new CiscoRouter('R9', 0, 0);
    await type(replica, ['enable', 'configure terminal', 'router ospf 1', ...lines, 'end']);
    expect(await ospfBlock(replica)).toBe(rendered);
  });

  it('show ip ospf ne fabrique plus de ligne Log-Adjacency-Changes', async () => {
    const { r1 } = await lab(['log-adjacency-changes detail']);
    expect(await r1.executeCommand('show ip ospf')).not.toContain('Log-Adjacency-Changes');
  });
});

describe('grammaire', () => {
  it('un mot inconnu est refuse, avec ou sans no', async () => {
    const { r1 } = await lab([]);
    await type(r1, ['configure terminal', 'router ospf 1']);
    expect(await r1.executeCommand('log-adjacency-changes zzz')).toContain('% Invalid input detected');
    expect(await r1.executeCommand('log-adjacency-changes detail zzz')).toContain('% Invalid input detected');
    expect(await r1.executeCommand('no log-adjacency-changes zzz')).toContain('% Invalid input detected');
  });
});
