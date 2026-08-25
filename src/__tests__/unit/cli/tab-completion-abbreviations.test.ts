/**
 * Une abreviation ANTERIEURE ne doit pas empecher la tabulation.
 *
 * Defaut rapporte : `sho runn` + Tab ne completait pas. La resolution
 * etait pourtant bonne — `cliTabComplete` rendait
 * `show running-config ` — mais la LISTE des candidats en portait deux :
 *
 *     ["sho running-config", "show running-config"]
 *
 * Un terminal qui a deux candidats liste au lieu de completer, donc Tab
 * paraissait ne rien faire. Le second candidat n'est pas une commande :
 * il garde le mot abrege tel qu'il a ete tape. Il venait du pont vers le
 * socle, qui recollait la suggestion au texte SAISI au lieu du mot du
 * registre.
 *
 * Ce fichier balaie l'arbre entier plutot que de lister des cas : pour
 * chaque commande connue, il abrege le premier mot et verifie qu'aucun
 * candidat ne garde l'abreviation. C'est ainsi que les dix familles
 * touchees ont ete trouvees, et c'est ce qui empechera la onzieme.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliTabComplete(input: string): string;
  cliTabCandidates(input: string): string[];
  getShell(): { enumerateAllExecutablePaths(): string[]; migratedPaths(): readonly string[] };
}

/*
 * Le balayage lit les DEUX moteurs. Ne lire que le trie faisait retrecir
 * la surface balayee a chaque famille migree — le garde-fou de volume
 * l'a attrape en tombant a 47 quand `router ospf|rip|eigrp|bgp` est
 * passe au socle — et aurait fini par ne plus rien prouver, justement
 * sur la moitie du vocabulaire ou le defaut d'origine vivait.
 */
function toutesLesCommandes(cli: Cli): string[] {
  const shell = cli.getShell();
  return [...new Set([...shell.enumerateAllExecutablePaths(), ...shell.migratedPaths()])];
}

let serial = 0;

async function router(): Promise<Cli> {
  const device = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await device.executeCommand('enable');
  return device;
}

describe('le cas rapporte, tel quel', () => {
  it('`sho runn` se complete en `show running-config`', async () => {
    const device = await router();

    expect(device.cliTabComplete('sho runn')).toBe('show running-config ');
  });

  it('et il n\'y a QU\'UN candidat — deux feraient lister au lieu de completer', async () => {
    const device = await router();

    expect(device.cliTabCandidates('sho runn')).toEqual(['show running-config']);
  });
});

describe('la meme frappe, a toutes les longueurs d\'abreviation', () => {
  it.each(['sh ru', 'sho ru', 'sho run', 'sho runn', 'show ru', 'show runn'])(
    '`%s` ne rend qu\'une ligne, et elle est ecrite en entier', async (frappe) => {
      const device = await router();

      expect(device.cliTabCandidates(frappe)).toEqual(['show running-config']);
    });
});

describe('les familles migrees, ou le defaut vivait', () => {
  it.each([
    ['sho nt', 'show ntp'],
    ['sho aa', 'show aaa'],
    ['sho snm', 'show snmp'],
    ['cle loggin', 'clear logging'],
    ['deb ip', 'debug ip'],
    ['cle ip', 'clear ip'],
  ])('`%s` ne propose aucune ligne commencant par le mot abrege', async (frappe, attendu) => {
    const device = await router();
    const abrege = frappe.split(' ')[0];
    const entier = attendu.split(' ')[0];

    const candidats = device.cliTabCandidates(frappe);

    expect(candidats.length).toBeGreaterThan(0);
    for (const c of candidats) expect(c.split(' ')[0], c).toBe(entier);
    expect(candidats.some(c => c.startsWith(`${abrege} `))).toBe(false);
  });
});

describe('le balayage — aucune commande ne garde son abreviation', () => {
  it('sur le routeur', async () => {
    const device = await router();
    const fautes: string[] = [];
    const vues = new Set<string>();

    for (const chemin of toutesLesCommandes(device)) {
      const mots = chemin.split(' ');
      if (mots.length < 2 || mots[0].length < 4) continue;
      const abrege = `${mots[0].slice(0, 3)} ${mots[1].slice(0, Math.max(2, mots[1].length - 1))}`;
      if (vues.has(abrege)) continue;
      vues.add(abrege);
      for (const c of device.cliTabCandidates(abrege)) {
        if (c.split(' ')[0] !== mots[0]) fautes.push(`${abrege} -> ${c}`);
      }
    }

    // Sans frappe balayee, le cas ne prouverait rien.
    expect(vues.size).toBeGreaterThan(300);
    expect(fautes, fautes.join('\n')).toEqual([]);
  }, 120_000);

  it('et sur le commutateur — meme repartiteur, meme regle', async () => {
    const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await device.executeCommand('enable');

    expect(device.cliTabCandidates('sho runn')).toEqual(['show running-config']);
    expect(device.cliTabCandidates('sho ver')).toEqual(['show version']);
  });
});

describe('une commande MIGREE se complete, comme les autres', () => {
  // Le defaut jumeau du precedent, trouve en le corrigeant : `tabComplete`
  // ne lisait que le trie quand `tabCandidates` lit les deux moteurs.
  // Une commande passee au socle avait donc UN candidat et se completait
  // en `null` — Tab ne faisait rien, sur `show clo`, `show ntp stat`,
  // `show snmp comm`, `show us`, `wri`… toute la surface migree.
  it.each([
    ['show clo', 'show clock '],
    ['show cloc', 'show clock '],
    ['show ntp stat', 'show ntp status '],
    ['show snmp comm', 'show snmp community '],
    ['show us', 'show users '],
    ['wri', 'write '],
  ])('`%s` se complete en `%s`', async (frappe, attendu) => {
    const device = await router();

    expect(device.cliTabCandidates(frappe)).toHaveLength(1);
    expect(device.cliTabComplete(frappe)).toBe(attendu);
  });

  it.each([
    ['show clo\t', 'show clock'],
    ['show ntp stat\t', 'show ntp status'],
  ])('et le terminal la complete aussi pour `%s`', async (frappe, attendu) => {
    const device = await router();

    expect(await device.executeCommand(frappe)).toBe(attendu);
  });

  it('une commande restee au trie se complete comme avant — le temoin', async () => {
    const device = await router();

    expect(device.cliTabComplete('clear count')).toBe('clear counters ');
  });
});

describe('plusieurs candidats : Tab ecrit le COMMUN, jamais un choix', () => {
  it('`show cl` n\'ecrit pas `show class-map` — l\'operateur n\'a pas choisi', async () => {
    const device = await router();

    expect(device.cliTabCandidates('show cl')).toContain('show class-map');
    expect(device.cliTabCandidates('show cl')).toContain('show clock');
    expect(device.cliTabComplete('show cl')).toBeNull();
  });

  it('et il ecrit le prefixe commun quand il est plus long que la frappe', async () => {
    const device = await router();

    const candidats = device.cliTabCandidates('show debu');
    const complete = device.cliTabComplete('show debu');

    expect(candidats.length).toBeGreaterThan(1);
    for (const c of candidats) expect(c.startsWith(complete!.trimEnd()), c).toBe(true);
  });
});

describe('ce qui marchait continue de marcher', () => {
  it.each([
    ['conf t', 'configure terminal '],
    ['sho ver', 'show version '],
    ['sho ip rou', 'show ip route '],
  ])('`%s` se complete en `%s`', async (frappe, attendu) => {
    expect((await router()).cliTabComplete(frappe)).toBe(attendu);
  });

  it('un prefixe AMBIGU rend plusieurs candidats — Tab n\'ecrit alors rien', async () => {
    const device = await router();

    expect(device.cliTabCandidates('show i').length).toBeGreaterThan(1);
  });
});
