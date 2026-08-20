/**
 * Un noeud qui ne mene nulle part ne se propose pas.
 *
 * Defaut mesure (audit completion, C2) : avec
 * `privilege exec level 5 show ip route`, la promotion des parentes hisse
 * `show ip` au niveau 5 — donc au niveau 1, RIEN sous `show ip` n'est
 * executable :
 *
 *     show ip route            -> % Invalid input
 *     show ip interface brief  -> % Invalid input
 *     show ip arp              -> % Invalid input
 *
 * et pourtant `show ?` offrait `ip`, et `Tab` proposait `show ip`.
 *
 * Le filtre existait, il ne portait que sur les FEUILLES : `laSessionVoit`
 * demande son niveau par defaut a la commande, et un noeud intermediaire
 * n'en a pas — il repondait donc « je ne sais pas », ce que le predicat
 * lisait comme « visible ». Un noeud est desormais visible s'il mene a
 * quelque chose de visible.
 *
 * La paire qui discrimine est `ip` contre `ipv6` : au meme instant, sur
 * la meme machine et au meme niveau, `show ipv6 interface brief`
 * S'EXECUTE. `ipv6` doit donc rester dans la liste. Un correctif qui
 * masquerait les deux serait aussi faux que celui qui n'en masque aucun,
 * et c'est le seul temoin qui les distingue.
 *
 * Le repli est deliberement OUVERT : un chemin sans aucun descendant
 * executable connu reste propose. Masquer ici n'est pas une frontiere de
 * securite — l'execution l'est, et elle refuse — donc en cas de doute on
 * prefere une liste trop large a une CLI amputee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Routeur = CiscoRouter & {
  cliHelp(s: string): string;
  cliTabCandidates(s: string): string[];
};

async function jouer(r: CiscoRouter, cmds: string[]): Promise<void> {
  for (const c of cmds) await r.executeCommand(c);
}

async function labo(nom: string): Promise<Routeur> {
  const r = new CiscoRouter(nom) as Routeur;
  await jouer(r, [
    'enable', 'configure terminal',
    'enable secret Coffre15!', 'enable secret level 5 Tech5!',
    'privilege exec level 1 show',
    'privilege exec level 5 show ip route',
    'end', 'disable',
  ]);
  return r;
}

/** Le mot-cle est-il propose au premier rang de cette liste d'aide ? */
const offre = (aide: string, mot: string): boolean =>
  new RegExp(`^\\s\\s${mot}\\s`, 'm').test(aide);

describe('C2 — une branche inatteignable ne parait plus', () => {
  it('la mesure de depart tient : rien sous `show ip` n est executable au niveau 1', async () => {
    const r = await labo('R1');
    expect(await r.executeCommand('show privilege')).toContain('level is 1');
    for (const c of ['show ip route', 'show ip interface brief', 'show ip arp']) {
      expect(String(await r.executeCommand(c)), c).toContain('Invalid input');
    }
  });

  it('`show ?` n offre plus `ip`', async () => {
    const r = await labo('R2');
    expect(offre(r.cliHelp('show '), 'ip')).toBe(false);
  });

  it('mais offre TOUJOURS `ipv6`, qui mene quelque part', async () => {
    const r = await labo('R3');
    expect(offre(r.cliHelp('show '), 'ipv6')).toBe(true);
    expect(await r.executeCommand('show ipv6 interface brief')).toContain('GigabitEthernet');
  });

  it('`Tab` suit la meme regle', async () => {
    const r = await labo('R4');
    const cand = r.cliTabCandidates('show i');
    expect(cand).not.toContain('show ip');
    expect(cand).toContain('show ipv6');
  });

  it('au niveau 5, `ip` revient — la branche est de nouveau atteignable', async () => {
    const r = await labo('R5');
    await r.executeCommand('enable 5', { passwordInput: 'Tech5!' });
    expect(offre(r.cliHelp('show '), 'ip')).toBe(true);
    expect(r.cliTabCandidates('show i')).toContain('show ip');
    expect(await r.executeCommand('show ip route')).toContain('Codes:');
  });

  it('tout ce que `?` propose au niveau 1 mene a une commande qui repond', async () => {
    const r = await labo('R6');
    const mots = r.cliHelp('show ').split('\n')
      .map((l) => /^\s\s(\S+)\s\s/.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');
    expect(mots.length).toBeGreaterThan(10);
    for (const m of mots) {
      expect(r.cliHelp(`show ${m} `), m).not.toBe("% Invalid input detected at '^' marker.");
    }
  });
});

describe('non-regression — sans regle de niveau, rien ne disparait', () => {
  it('au niveau 15 la liste est complete', async () => {
    const r = new CiscoRouter('R7') as Routeur;
    await jouer(r, ['enable']);
    const aide = r.cliHelp('show ');
    for (const m of ['ip', 'ipv6', 'interfaces', 'version', 'running-config']) {
      expect(offre(aide, m), m).toBe(true);
    }
  });

  it('sur une machine neuve au niveau 1, la liste utilisateur est complete', async () => {
    const r = new CiscoRouter('R8') as Routeur;
    const aide = r.cliHelp('show ');
    for (const m of ['ip', 'ipv6', 'interfaces', 'version']) {
      expect(offre(aide, m), m).toBe(true);
    }
  });

  it('la liste racine d un mode reste entiere', async () => {
    const r = await labo('R9');
    const aide = r.cliHelp('');
    for (const m of ['show', 'ping', 'enable', 'exit']) {
      expect(offre(aide, m), m).toBe(true);
    }
  });
});
