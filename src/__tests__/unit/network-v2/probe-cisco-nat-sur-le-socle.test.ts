/**
 * La section NAT de Cisco IOS est declaree sur le socle, plus sur le trie.
 *
 * MESURE DE DEPART : `buildNATConfigCommands`, `buildNATInterfaceCommands`,
 * `registerNATPrivilegedCommands` et `registerNATShowCommands` posaient
 * chacun leurs commandes sur un trie, et `natConfigSpecs` / `natExecSpecs`
 * / `natShowSpecs` les relisaient par `specsFromTrieRegistrations` pour
 * les exposer au socle. Chaque commande existait donc DEUX fois, et le
 * trie n'etait jamais atteint pour elle : le socle repond d'abord.
 *
 * DISCRIMINATION : sur le code d'avant, DIX cas tombent — la STRUCTURE
 * (le trie portait plus de cinquante chemins `ip nat`, de `ip nat inside
 * source static` a `clear ip nat translation pool`) et neuf changements
 * MESURES. `show ip nat statistics vrf` sans nom repondait
 * `% VRF undefined does not exist.` et repond `% Incomplete command.` ;
 * `show ip nat translations verbose vrf RED inside local <ip>` ignorait le
 * filtre apres le nom du VRF alors qu'il l'evalue desormais ; et les sept
 * `no ip nat translation <delai>` etaient refusees au caret, la ou IOS
 * retablit le delai par defaut — lequel n'etait ecrit qu'une fois dans le
 * moteur et une seconde dans le rendu du running-config, et ne l'est plus
 * qu'une. Les SEPT autres passent des deux cotes : le temoin prouve que
 * l'enumeration voit le trie, les cinq de comportement que retirer le trie
 * ne retire rien de ce que la machine repond.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

type Machine = {
  executeCommand(c: string): Promise<string>;
  getShell(): { enumerateAllCommandPaths(): string[] };
};

async function routeur(): Promise<Machine> {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  const r = new CiscoRouter('R1', 0, 0) as unknown as Machine;
  await r.executeCommand('enable');
  return r;
}

async function configure(r: Machine, lignes: string[]): Promise<void> {
  await r.executeCommand('configure terminal');
  for (const ligne of lignes) await r.executeCommand(ligne);
  await r.executeCommand('end');
}

describe('le trie ne porte plus aucune commande NAT', () => {
  it('TEMOIN : le trie porte bien des chemins, dont ceux de `crypto isakmp nat`', async () => {
    const chemins = (await routeur()).getShell().enumerateAllCommandPaths();
    expect(chemins.length).toBeGreaterThan(100);
    expect(chemins).toContain('crypto isakmp nat keepalive');
  });

  it('aucun chemin du trie ne porte `ip nat`', async () => {
    const chemins = (await routeur()).getShell().enumerateAllCommandPaths();
    expect(chemins.filter(p => /(^|\s)ip nat(\s|$)/.test(p))).toEqual([]);
  });

  it('et pourtant `?` annonce toujours la famille', async () => {
    const r = await routeur() as unknown as { cliHelp(i: string): string } & Machine;
    expect(r.cliHelp('show ip nat ')).toContain('translations');
    expect(r.cliHelp('clear ip nat ')).toContain('translation');
  });
});

describe('et la machine repond comme avant', () => {
  it('une statique se pose, se montre et se retire', async () => {
    const r = await routeur();
    await configure(r, ['ip nat inside source static 10.0.0.5 203.0.113.5']);
    expect(await r.executeCommand('show ip nat translations')).toContain('203.0.113.5');
    await configure(r, ['no ip nat inside source static 10.0.0.5 203.0.113.5']);
    expect(await r.executeCommand('show ip nat translations')).not.toContain('203.0.113.5');
  });

  it('une reserve mal alignee EXPLIQUE son refus', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('ip nat pool P 10.0.0.1 10.1.0.1 netmask 255.255.255.0'))
      .toBe('% IP range does not align with netmask.');
  });

  it('une reserve en cours d usage ne s efface pas', async () => {
    const r = await routeur();
    await configure(r, [
      'access-list 1 permit any',
      'ip nat pool P 10.0.0.1 10.0.0.9 netmask 255.255.255.0',
      'ip nat inside source list 1 pool P',
    ]);
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('no ip nat pool P'))
      .toBe('% Pool is in use by an active list translation.');
  });

  it('`clear ip nat translation vrf ZORG` EXPLIQUE son refus', async () => {
    const r = await routeur();
    expect(await r.executeCommand('clear ip nat translation vrf ZORG'))
      .toBe('% VRF ZORG does not exist.');
  });

  it('`show ip nat translations timeout` rend les sept delais', async () => {
    const r = await routeur();
    const sortie = await r.executeCommand('show ip nat translations timeout');
    expect(sortie.split('\n')).toHaveLength(7);
  });
});

describe('deux refus qui nommaient un mot absent ou ignoraient un critere', () => {
  it('`show ip nat statistics vrf` sans nom est incomplete', async () => {
    const r = await routeur();
    expect(await r.executeCommand('show ip nat statistics vrf')).toBe('% Incomplete command.');
  });

  it('le filtre apres le VRF est evalue', async () => {
    const r = await routeur();
    await configure(r, [
      'ip vrf RED',
      'ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED',
    ]);
    const garde = await r.executeCommand(
      'show ip nat translations verbose vrf RED inside local 192.168.1.10');
    const ecarte = await r.executeCommand(
      'show ip nat translations verbose vrf RED inside local 192.168.9.9');
    expect(garde).toContain('192.168.1.10');
    expect(ecarte).not.toContain('192.168.1.10');
  });
});

describe('`no ip nat translation <delai>` retablit le delai par defaut', () => {
  it.each([
    'timeout', 'tcp-timeout', 'udp-timeout', 'icmp-timeout',
    'syn-timeout', 'dns-timeout', 'finrst-timeout',
  ])('%s', async (mot) => {
    const r = await routeur();
    await configure(r, [`ip nat translation ${mot} 77`]);
    expect(await r.executeCommand('show running-config')).toContain(`ip nat translation ${mot} 77`);
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand(`no ip nat translation ${mot}`)).toBe('');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain(`ip nat translation ${mot}`);
  });
});
