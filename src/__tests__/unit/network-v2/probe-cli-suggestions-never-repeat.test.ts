/**
 * `?` never offers a keyword that has already been typed.
 *
 * The defect reported from a real session, on `tacacs`:
 *
 *     Router(config)#tacacs server ?
 *       server  Server
 *       <cr>
 *     Router(config)#tacacs server server ?
 *       server  Server
 *       <cr>
 *     Router(config)#tacacs-server host key ?
 *       host     A single host address
 *       key      Key management
 *       port     Port number
 *       timeout  Timeout interval
 *
 * — the same list, forever, whatever had been typed. It is not a
 * `tacacs` quirk: `nodeCompletionsUnsorted` guards its keyword
 * suggestions with `consumedArgs > 0 && node.params.length >
 * consumedArgs`, which is FALSE for every greedy node that declares no
 * `params` at all. So each such node re-offered its children, its
 * `addCompletionKeywords` hints and its auto-extracted continuations at
 * every depth, on every platform and in every mode.
 *
 * This suite is a RATCHET, not a spot check: it walks each mode of each
 * platform, types every keyword `?` offers, and asks again. A keyword
 * that comes back after being consumed is a fault, wherever it is.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cli {
  executeCommand(c: string): Promise<string> | string;
  cliHelp(s: string): string;
}

/** The keywords `?` offers, ignoring type placeholders and `<cr>`. */
function keywords(help: string): string[] {
  if (/Invalid input|Unrecognized|Ambiguous|Wrong parameter/.test(help)) return [];
  return help.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.search(/\s{2,}/);
      return i < 0 ? l : l.slice(0, i);
    })
    .filter((k) => k !== '<cr>' && !k.startsWith('<') && !k.startsWith('%')
      && !/^[A-Z][A-Z0-9._-]*$/.test(k) && !/^[\d.]+$/.test(k)
      && !/^[A-Z]\.[A-Z]/.test(k) && !k.includes(':'));
}

/**
 * Walk a mode, typing what `?` offers and asking again. Returns the
 * faults: a keyword offered a second time when it is already on the
 * line.
 */
/**
 * Les places ou la VALEUR attendue porte le nom de la commande.
 *
 * Relevees plutot qu'ouvertes : l'egalite est exacte, donc une nouvelle
 * homonymie ne peut pas s'y glisser sans etre ecrite ici.
 */
const VALEUR_HOMONYME = new Set(['stp mode stp']);

async function walk(
  cli: Cli, mode: string[], label: string, depth = 3,
): Promise<string[]> {
  const faults: string[] = [];
  const seenPrefix = new Set<string>();

  const visit = async (prefix: string, typed: string[], left: number): Promise<void> => {
    if (left === 0 || seenPrefix.has(prefix)) return;
    seenPrefix.add(prefix);
    const help = cli.cliHelp(prefix);
    const offered = keywords(help);
    // `do` et `default` sont des PREFIXES : ils ne font pas partie de la
    // commande qu'ils portent, et l'aide qui suit est celle d'un autre
    // arbre. `default bgp default ipv4-unicast` est une vraie ligne IOS,
    // donc `default` reste offert derriere `default bgp` sans se
    // repeter — c'est le premier mot qui n'est pas du meme discours.
    const already = new Set(
      typed.filter((t, i) => !(i === 0 && /^(do|default)$/i.test(t)))
        .map((t) => t.toLowerCase()));
    for (const k of offered) {
      // Une VALEUR n'est pas un mot-cle, et elle peut porter le meme nom
      // que la commande : VRP repond bien `stp` a `stp mode ?`, puisque
      // `stp mode stp` selectionne le protocole 802.1D. La regle « jamais
      // deux fois » parle des mots-cles qui se SUIVENT ; ici le second
      // `stp` est la valeur du premier, et une vraie machine l'offre.
      if (VALEUR_HOMONYME.has(`${prefix.trim()} ${k}`.toLowerCase())) continue;
      if (already.has(k.toLowerCase())) {
        faults.push(`${label}: "${prefix}?" offre encore « ${k} », déjà tapé`);
        continue;
      }
      await visit(`${prefix}${k} `, [...typed, k], left - 1);
    }
  };

  for (const c of mode) await cli.executeCommand(c);
  await visit('', [], depth);
  return faults;
}

async function ciscoRouter(): Promise<CiscoRouter & Cli> {
  const r = new CiscoRouter('R1') as CiscoRouter & Cli;
  r.powerOn?.();
  await r.executeCommand('enable');
  return r;
}

async function ciscoSwitch(): Promise<CiscoSwitch & Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8) as CiscoSwitch & Cli;
  s.powerOn?.();
  await s.executeCommand('enable');
  return s;
}

async function huaweiRouter(): Promise<HuaweiRouter & Cli> {
  const r = new HuaweiRouter('AR1') as HuaweiRouter & Cli;
  r.powerOn?.();
  return r;
}

async function huaweiSwitch(): Promise<HuaweiSwitch & Cli> {
  const s = new HuaweiSwitch('huawei-switch', 'SW1', 8) as HuaweiSwitch & Cli;
  s.powerOn?.();
  return s;
}

const CISCO_ROUTER_MODES: Array<[string, string[]]> = [
  ['IOS privileged EXEC', []],
  ['IOS global config', ['configure terminal']],
  ['IOS config-if', ['configure terminal', 'interface GigabitEthernet0/0']],
  ['IOS config-line', ['configure terminal', 'line vty 0 4']],
  ['IOS config-router (OSPF)', ['configure terminal', 'router ospf 1']],
  ['IOS config-router (BGP)', ['configure terminal', 'router bgp 65001']],
  ['IOS config-dhcp', ['configure terminal', 'ip dhcp pool P']],
];

const CISCO_SWITCH_MODES: Array<[string, string[]]> = [
  ['Catalyst privileged EXEC', []],
  ['Catalyst global config', ['configure terminal']],
  ['Catalyst config-if', ['configure terminal', 'interface FastEthernet0/1']],
  ['Catalyst config-vlan', ['configure terminal', 'vlan 10']],
];

const VRP_ROUTER_MODES: Array<[string, string[]]> = [
  ['VRP user view', []],
  ['VRP system view', ['system-view']],
  ['VRP interface view', ['system-view', 'interface GigabitEthernet0/0/0']],
  ['VRP aaa view', ['system-view', 'aaa']],
];

const VRP_SWITCH_MODES: Array<[string, string[]]> = [
  ['VRP switch user view', []],
  ['VRP switch system view', ['system-view']],
  ['VRP switch interface view', ['system-view', 'interface GigabitEthernet0/0/1']],
  ['VRP switch vlan view', ['system-view', 'vlan 10']],
];

describe('aucune suggestion ne se répète après avoir été tapée', () => {
  for (const [label, mode] of CISCO_ROUTER_MODES) {
    it(label, async () => {
      const faults = await walk(await ciscoRouter(), mode, label);
      expect(faults, faults.slice(0, 25).join('\n')).toEqual([]);
    }, 180_000);
  }

  for (const [label, mode] of CISCO_SWITCH_MODES) {
    it(label, async () => {
      const faults = await walk(await ciscoSwitch(), mode, label);
      expect(faults, faults.slice(0, 25).join('\n')).toEqual([]);
    }, 180_000);
  }

  for (const [label, mode] of VRP_ROUTER_MODES) {
    it(label, async () => {
      const faults = await walk(await huaweiRouter(), mode, label);
      expect(faults, faults.slice(0, 25).join('\n')).toEqual([]);
    }, 180_000);
  }

  for (const [label, mode] of VRP_SWITCH_MODES) {
    it(label, async () => {
      const faults = await walk(await huaweiSwitch(), mode, label);
      expect(faults, faults.slice(0, 25).join('\n')).toEqual([]);
    }, 180_000);
  }
});

describe('le cas rapporté, tel quel', () => {
  it('`tacacs server` ne se propose plus lui-même', async () => {
    const r = await ciscoRouter();
    await r.executeCommand('configure terminal');
    expect(r.cliHelp('tacacs ')).toContain('server');
    expect(keywords(r.cliHelp('tacacs server '))).not.toContain('server');
  }, 30_000);

  it('`tacacs-server host` ne repropose ni `host` ni ce qui le précède', async () => {
    const r = await ciscoRouter();
    await r.executeCommand('configure terminal');
    const nu = keywords(r.cliHelp('tacacs-server '));
    expect(nu).toEqual(expect.arrayContaining(['host', 'key', 'port', 'timeout']));
    const apres = keywords(r.cliHelp('tacacs-server host '));
    expect(apres).not.toContain('host');
    const encore = keywords(r.cliHelp('tacacs-server host key '));
    expect(encore).not.toContain('host');
    expect(encore).not.toContain('key');
  }, 30_000);

  it('une option déjà donnée disparaît, les autres restent', async () => {
    const r = await ciscoRouter();
    const nu = keywords(r.cliHelp('ping 1.1.1.1 '));
    expect(nu).toEqual(expect.arrayContaining(['repeat', 'size', 'source', 'timeout']));
    const apres = keywords(r.cliHelp('ping 1.1.1.1 repeat 5 '));
    expect(apres).not.toContain('repeat');
    expect(apres).toEqual(expect.arrayContaining(['size', 'source', 'timeout']));
  }, 30_000);

  it('un sélecteur de protocole ne se propose qu\'AVANT la cible', async () => {
    const r = await ciscoRouter();
    // `ping ip 1.1.1.1` existe, `ping 1.1.1.1 ip` non.
    expect(keywords(r.cliHelp('ping '))).toEqual(expect.arrayContaining(['ip', 'ipv6']));
    expect(keywords(r.cliHelp('ping 1.1.1.1 '))).not.toContain('ip');
    expect(keywords(r.cliHelp('traceroute 1.1.1.1 '))).not.toContain('ipv6');
  }, 30_000);

  it('un mot-clé de ligne ne propose plus l\'union de ses dix-neuf frères', async () => {
    const r = await ciscoRouter();
    await r.executeCommand('configure terminal');
    await r.executeCommand('line vty 0 4');
    // Vingt mots-clés partagent un seul aiguillage, dont le corps était
    // gratté pour deviner les suites de chacun.
    expect(keywords(r.cliHelp('login '))).toEqual(['authentication', 'local']);
    expect(keywords(r.cliHelp('logging '))).toEqual(['synchronous']);
    expect(keywords(r.cliHelp('privilege '))).toEqual(['level']);
    expect(r.cliHelp('privilege level ')).toContain('<0-15>');
    // Et ce que l'aide annonce, la machine l'accepte.
    expect(await r.executeCommand('login local')).toBe('');
    expect(await r.executeCommand('logging synchronous')).toBe('');
    expect(await r.executeCommand('privilege level 15')).toBe('');
  }, 30_000);

  it('un mot-clé absorbé par un parent glouton reste exécutable et continuable', async () => {
    const r = await ciscoRouter();
    await r.executeCommand('configure terminal');
    // `host` n'est pas un vrai nœud : le handler de `tacacs-server`
    // l'absorbe. L'aide en tirait que la commande n'était pas
    // exécutable ici et que rien ne pouvait suivre.
    expect(r.cliHelp('tacacs-server host ')).toContain('A.B.C.D');
    expect(r.cliHelp('tacacs-server host 1.1.1.1 ')).toContain('<cr>');
    expect(keywords(r.cliHelp('tacacs-server host 1.1.1.1 key SEC ')))
      .toEqual(expect.arrayContaining(['port', 'timeout']));
    expect(await r.executeCommand('tacacs-server host 1.1.1.1 key SEC port 49')).toBe('');
  }, 30_000);
});

/**
 * `?` et Tab lisent la MÊME règle.
 *
 * Corriger `?` seul laissait la moitié du défaut en place : la
 * complétion par tabulation est une SECONDE marche (`tabCandidates`),
 * avec ses propres gardes, qui proposait encore ce que `?` venait
 * d'arrêter de proposer. Deux réponses à une même question, c'est le
 * défaut que ce dépôt referme partout ailleurs.
 *
 * L'invariant n'est pas « les deux listes sont identiques » — Tab
 * accepte délibérément un mot-clé réel pas encore décrit, que `?`
 * masque, et c'est écrit dans `autoContinuations`. L'invariant est plus
 * étroit et plus vrai : **Tab ne propose jamais ce que `?` a
 * délibérément RETIRÉ** — un mot déjà tapé, un sélecteur de protocole
 * après la cible.
 */
interface TabCli extends Cli {
  cliTabCandidates(input: string): string[];
}

/** Le dernier mot de chaque candidat, qui est ce que Tab ajouterait. */
function tabWords(cli: TabCli, prefix: string): string[] {
  return cli.cliTabCandidates(prefix)
    .map((c) => c.trim().split(/\s+/).pop() ?? '')
    .filter(Boolean);
}

/**
 * Marche la même arborescence que la sonde `?`, mais interroge Tab
 * comme un opérateur le fait : avec un DÉBUT de mot.
 *
 * La première écriture demandait Tab sur un préfixe finissant par une
 * espace — or `tabCandidates` rend `[]` dans ce cas, donc les dix-neuf
 * cas passaient sans rien vérifier. C'est la faute que cette suite est
 * censée attraper chez les autres ; elle est notée ici plutôt que
 * corrigée en silence.
 */
async function walkTab(
  cli: TabCli, mode: string[], label: string, depth = 3,
): Promise<string[]> {
  const faults: string[] = [];
  const seenPrefix = new Set<string>();

  const visit = async (prefix: string, typed: string[], left: number): Promise<void> => {
    if (left === 0 || seenPrefix.has(prefix)) return;
    seenPrefix.add(prefix);
    // Même exemption que la marche `?` : un `do` ou `default` de tête
    // n'appartient pas à la commande qu'il porte, donc le revoir plus
    // loin n'est pas une répétition — `default escape-character default`
    // est une vraie ligne IOS.
    const already = new Set(
      typed.filter((t, i) => !(i === 0 && /^(do|default)$/i.test(t)))
        .map((t) => t.toLowerCase()));
    // Ce que `?` connaît à cette place sert de plan de marche ; ce que
    // Tab en fait est ce qu'on vérifie.
    for (const k of keywords(cli.cliHelp(prefix))) {
      for (const t of tabWords(cli, `${prefix}${k[0]}`)) {
        // Meme exception que pour `?` : une valeur homonyme de sa
        // commande est ce qu'une vraie machine complete la.
        if (VALEUR_HOMONYME.has(`${prefix.trim()} ${t}`.toLowerCase())) continue;
        if (already.has(t.toLowerCase())) {
          faults.push(`${label}: Tab après "${prefix}${k[0]}" propose « ${t} », déjà tapé`);
        }
      }
      if (!already.has(k.toLowerCase())) {
        await visit(`${prefix}${k} `, [...typed, k], left - 1);
      }
    }
  };

  for (const c of mode) await cli.executeCommand(c);
  await visit('', [], depth);
  return [...new Set(faults)];
}

describe('Tab lit la même règle que `?`', () => {
  for (const [label, mode] of CISCO_ROUTER_MODES) {
    it(`${label} (Tab)`, async () => {
      const r = await ciscoRouter();
      const faults = await walkTab(r as unknown as TabCli, mode, label);
      expect(faults, faults.slice(0, 25).join('\n')).toEqual([]);
    }, 180_000);
  }

  for (const [label, mode] of CISCO_SWITCH_MODES) {
    it(`${label} (Tab)`, async () => {
      const s = await ciscoSwitch();
      const faults = await walkTab(s as unknown as TabCli, mode, label);
      expect(faults, faults.slice(0, 25).join('\n')).toEqual([]);
    }, 180_000);
  }

  for (const [label, mode] of VRP_ROUTER_MODES) {
    it(`${label} (Tab)`, async () => {
      const r = await huaweiRouter();
      const faults = await walkTab(r as unknown as TabCli, mode, label);
      expect(faults, faults.slice(0, 25).join('\n')).toEqual([]);
    }, 180_000);
  }

  for (const [label, mode] of VRP_SWITCH_MODES) {
    it(`${label} (Tab)`, async () => {
      const s = await huaweiSwitch();
      const faults = await walkTab(s as unknown as TabCli, mode, label);
      expect(faults, faults.slice(0, 25).join('\n')).toEqual([]);
    }, 180_000);
  }

  it('le cas rapporté : Tab ne recomplète pas `server` après `tacacs server`', async () => {
    const r = await ciscoRouter();
    await r.executeCommand('configure terminal');
    const cli = r as unknown as TabCli;
    expect(tabWords(cli, 'tacacs s')).toContain('server');
    expect(tabWords(cli, 'tacacs server s')).not.toContain('server');
    // L'option se complete APRES l'adresse, jamais a sa place : la
    // premisse d'origine placait `key` au rang de l'adresse, ou la
    // machine n'accepte qu'un `A.B.C.D` — le cas voisin l'exige deja.
    expect(tabWords(cli, 'tacacs-server host 1.1.1.1 k')).toContain('key');
    expect(tabWords(cli, 'tacacs-server host 1.1.1.1 key SEC k'))
      .not.toContain('key');
  }, 30_000);

  it('un sélecteur de protocole ne se recomplète pas après la cible', async () => {
    const r = await ciscoRouter();
    const cli = r as unknown as TabCli;
    expect(tabWords(cli, 'ping i')).toEqual(expect.arrayContaining(['ip', 'ipv6']));
    expect(tabWords(cli, 'ping 1.1.1.1 i')).not.toContain('ip');
  }, 30_000);

  it('un mot-clé absorbé par un parent glouton reste complétable au-delà', async () => {
    const r = await ciscoRouter();
    await r.executeCommand('configure terminal');
    const cli = r as unknown as TabCli;
    // `host` est un nœud purement indicatif : la marche de Tab s'y
    // arrêtait et ne rendait plus rien.
    expect(tabWords(cli, 'tacacs-server host 1.1.1.1 p')).toContain('port');
  }, 30_000);
});
