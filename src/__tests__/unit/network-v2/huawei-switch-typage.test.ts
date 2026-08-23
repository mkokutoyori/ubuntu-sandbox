/**
 * PRD-CLI-Fidelite-VRP.md §19 / lot V10 — le typage de
 * `HuaweiSwitchShell`, et ce qu'il cachait.
 *
 * Un `as unknown as` ne coute pas une ligne de lint et eteint le
 * compilateur exactement comme un `any`. Les 37 du fichier en cachaient
 * trois choses REELLES, et ce sont elles que ce fichier verifie — le
 * typage lui-meme etant garde par le compilateur, pas par un test :
 *
 * 1. Les lignes de vue VLAN etaient rangees et rendues par PERSONNE :
 *    la configuration les perdait, donc l'import aussi.
 * 2. Une vue que le switch n'a pas rendait le shell MUET au lieu de le
 *    laisser ou il etait.
 * 3. `protocol inbound` ne gouverne rien sur un switch — le cast
 *    l'affirmait sous un commentaire disant le contraire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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
interface Cli { executeCommand(c: string): Promise<string>; getPrompt(): string }

async function sw(vue: readonly string[] = []): Promise<Cli> {
  const d = new HuaweiSwitch('switch-huawei', `T${++serie}`) as unknown as Cli;
  for (const c of vue) await d.executeCommand(c);
  return d;
}

const SHELL = 'src/network/devices/shells/HuaweiSwitchShell.ts';

describe('la configuration de vue VLAN ne se perd plus', () => {
  it('`igmp-snooping` sous un VLAN revient dans la configuration', async () => {
    const s = await sw(['system-view', 'igmp-snooping enable', 'vlan 10',
      'igmp-snooping enable', 'igmp-snooping fast-leave', 'quit']);
    const cfg = await s.executeCommand('display current-configuration');
    expect(cfg).toContain('vlan 10');
    expect(cfg).toContain('igmp-snooping enable');
    expect(cfg).toContain('igmp-snooping fast-leave');
  });

  it('les autres lignes de vue VLAN aussi', async () => {
    const s = await sw(['system-view', 'vlan 20']);
    for (const ligne of ['mux-vlan', 'vlan-type dot1q 20', 'mac-vlan mac-address 0011-2233-4455']) {
      await s.executeCommand(ligne);
    }
    await s.executeCommand('quit');
    const cfg = await s.executeCommand('display current-configuration');
    for (const ligne of ['mux-vlan', 'vlan-type dot1q 20', 'mac-vlan mac-address 0011-2233-4455']) {
      expect(cfg, ligne).toContain(ligne);
    }
  });

  it('elles sont rangees SOUS leur VLAN, pas ailleurs', async () => {
    const s = await sw(['system-view', 'vlan 10', 'mux-vlan', 'quit',
      'vlan 20', 'quit']);
    const cfg = await s.executeCommand('display current-configuration');
    const lignes = cfg.split('\n');
    const iDix = lignes.findIndex(l => l.trim() === 'vlan 10');
    const iVingt = lignes.findIndex(l => l.trim() === 'vlan 20');
    const iMux = lignes.findIndex(l => l.trim() === 'mux-vlan');
    expect(iDix).toBeGreaterThanOrEqual(0);
    expect(iMux).toBeGreaterThan(iDix);
    expect(iMux).toBeLessThan(iVingt);
  });

  it('un VLAN sans ligne supplementaire n\'en gagne pas', async () => {
    const s = await sw(['system-view', 'vlan 30', 'quit']);
    const cfg = await s.executeCommand('display current-configuration');
    expect(cfg).toContain('vlan 30');
    expect(cfg).not.toContain('undefined');
  });
});

describe('une vue que le switch n\'a pas ne le rend pas muet', () => {
  /** L'unique chemin d'ecriture de la vue, hors commandes. */
  const appliquer = (c: Cli, mode: string) =>
    (c as unknown as { getShell(): { applyVtyState(s: Record<string, unknown>): void } })
      .getShell().applyVtyState({
      mode, selectedInterface: null, selectedVlan: null, selectedMqcName: null,
      selectedPortGroup: [], selectedDHCPPool: null, selectedACL: null,
      cmdHistory: [],
    });

  const vueCourante = (c: Cli) =>
    (c as unknown as { getShell(): { getMode(): string } }).getShell().getMode();

  it('une vue du ROUTEUR ne devient pas la vue du switch', async () => {
    for (const vueRouteur of ['ospf-area', 'ike-peer', 'acl-basic', 'nqa-test', 'zzz']) {
      const s = await sw();
      appliquer(s, vueRouteur);
      // Avant, la vue etait POSEE telle quelle et `getActiveTrie()`
      // retombait sur `default` : une trie muette sous un nom de vue qui
      // n'existe pas. C'est le nom retenu qui distingue les deux, le
      // reste etant identique par coincidence.
      expect(vueCourante(s), vueRouteur).toBe('user');
      expect(s.getPrompt(), vueRouteur).toMatch(/^</);
      expect(await s.executeCommand('system-view'), vueRouteur)
        .toContain('Enter system view');
    }
  });

  it('une vue que le switch A, elle, est bien restauree', async () => {
    for (const [vue, invite] of [
      ['system', /^\[[^-\]]+\]$/],
      ['vlan', /vlan/],
      ['acl', /acl/],
    ] as const) {
      const s = await sw();
      appliquer(s, vue);
      expect(s.getPrompt(), vue).toMatch(invite);
    }
  });
});

describe('ce que le port declare, et ce que l equipement fournit', () => {
  it('`protocol inbound` est accepte ET range sur le commutateur', async () => {
    const s = await sw(['system-view', 'user-interface vty 0 4']);
    expect(await s.executeCommand('protocol inbound ssh')).toBe('');
    expect((s as unknown as { _getVtyTransportInput(): string })._getVtyTransportInput())
      .toBe('ssh');
    expect(await s.executeCommand('undo protocol inbound ssh')).toBe('');
    expect((s as unknown as { _getVtyTransportInput(): string })._getVtyTransportInput())
      .toBe('telnet');
  });

  it('aucun `as unknown as` ni `as any` ne subsiste dans le shell', () => {
    const src = readFileSync(SHELL, 'utf8');
    expect(src).not.toContain('as unknown as');
    expect(src.match(/\bas any\b/)).toBeNull();
  });

  it('les magasins de la vue ACL ne sont plus morts : ils vivent sur le moteur', async () => {
    // Ce test epinglait la DECLARATION de `description?: string; step?:
    // number;` sur le shell, au motif qu'un magasin mort declare vaut
    // mieux qu'un magasin mort cache par un cast. Les deux champs sont
    // desormais VIVANTS, portes par la liste que le moteur evalue -- la
    // declaration morte n'a plus de raison d'exister, et ce qu'il faut
    // tenir est qu'ils soient lus. Voir AUDIT-ACL-HUAWEI-SWITCH.md.
    const s = await sw(['system-view', 'acl 2000', 'step 20', 'description invites',
      'rule permit source 10.0.0.0 0.0.0.255', 'quit']);
    const acl = s.getVaclEngine().findById(2000)!;
    expect(acl.step).toBe(20);
    expect(acl.description).toBe('invites');
    expect(acl.entries[0].sequence).toBe(20);
    expect(await s.executeCommand('display acl 2000')).toContain('invites');
  });

  it('le shell ne tient plus de table de regles a cote du moteur', () => {
    const src = readFileSync(SHELL, 'utf8');
    // Deux magasins pour une regle, c'est `undo rule` qui efface le texte
    // en laissant la regle filtrer. Il n'y en a plus qu'un.
    expect(src).not.toContain('rules: string[]');
    expect(src).not.toContain('parseVrpAclRule');
  });
});

describe('rien de ce qui marchait n\'a bouge', () => {
  it('les agents repondent toujours', async () => {
    const s = await sw(['system-view']);
    expect(await s.executeCommand('stp mode rstp')).toBe('');
    expect(await s.executeCommand('lldp enable')).not.toMatch(/Unrecognized/);
    await s.executeCommand('quit');
    expect(await s.executeCommand('display stp')).toContain('Mode RSTP');
  });

  it('le NAT du switch se rend toujours', async () => {
    const s = await sw(['system-view', 'interface Vlanif 10', 'quit']);
    expect(await s.executeCommand('display current-configuration'))
      .toContain('interface Vlanif10');
  });

  it('l\'etat d\'une interface L3 se rend, avec et sans adresse', async () => {
    const s = await sw(['system-view', 'vlan 10', 'quit',
      'interface Vlanif 10', 'quit', 'quit']);
    const sans = await s.executeCommand('display ip interface Vlanif10');
    expect(sans).toContain('Internet protocol processing : disabled');

    const t = await sw(['system-view', 'vlan 20', 'quit', 'interface Vlanif 20',
      'ip address 10.0.20.1 255.255.255.0', 'quit', 'quit']);
    const avec = await t.executeCommand('display ip interface Vlanif20');
    expect(avec).toContain('Internet Address is 10.0.20.1/24');
  });
});
