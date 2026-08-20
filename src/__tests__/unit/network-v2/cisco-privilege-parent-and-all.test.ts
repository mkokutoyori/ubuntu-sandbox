/**
 * Les deux regles d'IOS sur l'ECRITURE d'une regle de privilege.
 *
 * Les etapes precedentes portaient sur la LECTURE des regles ; ces deux
 * defauts (audit §3, M3 et M6) portent sur ce qu'ECRIRE une regle veut
 * dire.
 *
 * M3 — la promotion des commandes PARENTES. Cisco l'ecrit sans
 * ambiguite : « When you set a command to a privilege level, all
 * commands whose syntax is a subset of that command are also set to that
 * level. For example, if you set the show ip traffic command to level
 * 15, the show commands and show ip commands are automatically set to
 * privilege level 15 unless you set them to a different level. »
 *
 * Ce n'est PAS cosmetique : c'est le piege n°1 du chapitre. Sur une
 * vraie machine, `privilege exec level 5 show running-config` retire
 * TOUS les `show` au niveau 1 — et c'est ce que l'apprenant doit
 * rencontrer, puis corriger en redescendant `show`. Le simulateur
 * enseignait une delegation sans effet de bord, donc une fausse
 * securite.
 *
 * M6 — le mot-cle `all`. `privilege <mode> all level <n> <commande>`
 * etend le niveau a la commande ET a tout ce qui la complete ; sans lui,
 * seule la commande NOMMEE change de niveau. Le simulateur refusait le
 * mot-cle (`% Incomplete command.`) et appliquait a TOUTE regle la
 * semantique d'`all` — les deux formes faisaient donc la meme chose,
 * qui etait celle de la seconde.
 *
 * La consequence des deux ensemble est la delegation reelle d'IOS :
 * `privilege exec level 5 show running-config` seul ne suffit pas, il
 * faut aussi redescendre `show`, et c'est precisement pour cela que
 * `privilege exec all level 5 show running-config` est la forme que la
 * documentation Cisco recommande.
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

const REFUS = '% Invalid input';

async function jouer(r: CiscoRouter, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await r.executeCommand(c);
  return derniere;
}

/** Un routeur configure, puis redescendu au niveau `niveau`. */
async function lab(regles: string[], niveau = 1): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', MACAddress.generate());
  await jouer(r, ['enable', 'configure terminal', ...regles, 'end', 'disable']);
  if (niveau > 1) await jouer(r, [`enable ${niveau}`]);
  return r;
}

describe('M3 — hisser une commande hisse ses parentes', () => {
  it('hisser `show ip traffic` a 15 retire TOUS les `show` au niveau 1', async () => {
    const r = await lab(['privilege exec level 15 show ip traffic']);
    expect(await r.executeCommand('show version')).toContain(REFUS);
    expect(await r.executeCommand('show ip route')).toContain(REFUS);
  });

  it('redescendre `show` explicitement le rend a nouveau joignable', async () => {
    const r = await lab([
      'privilege exec level 15 show ip traffic',
      'privilege exec level 1 show',
    ]);
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    // La commande NOMMEE, elle, reste au niveau ou on l'a hissee.
    expect(await r.executeCommand('show ip traffic')).toContain(REFUS);
  });

  it('une regle EXPLICITE sur la parente l emporte sur la promotion', async () => {
    const r = await lab([
      'privilege exec level 5 show',
      'privilege exec level 15 show ip traffic',
    ], 5);
    expect(await r.executeCommand('show privilege')).toContain('level is 5');
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('show ip traffic')).toContain(REFUS);
  });

  it('la promotion suit la commande CANONIQUE, pas la frappe', async () => {
    const r = await lab(['privilege exec level 15 sh ip traf']);
    expect(await r.executeCommand('show version')).toContain(REFUS);
    expect(await r.executeCommand('sh ver')).toContain(REFUS);
  });
});

describe('M6 — `all` etend la regle a ce qui complete la commande', () => {
  it('le mot-cle est accepte', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    expect(await jouer(r, [
      'enable', 'configure terminal', 'privilege exec all level 5 show ip',
    ])).toBe('');
  });

  it('SANS `all`, seule la commande nommee change de niveau', async () => {
    // `show ip` descend a 5, donc `show` devient joignable a 5 ; mais
    // `show ip route`, qui est au niveau 1 par defaut, n'est PAS hisse,
    // et `show running-config`, au niveau 15, n'est PAS descendu.
    const r = await lab(['privilege exec level 5 show ip'], 5);
    expect(await r.executeCommand('show ip route')).not.toContain(REFUS);
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
  });

  it('AVEC `all`, ce qui complete la commande suit', async () => {
    const r = await lab(['privilege exec all level 5 show'], 5);
    expect(await r.executeCommand('show privilege')).toContain('level is 5');
    expect(await r.executeCommand('show running-config')).toContain('Building configuration');
    expect(await r.executeCommand('show ip route')).not.toContain(REFUS);
  });

  it('`all` se rend tel qu il a ete tape', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal',
      'privilege exec all level 5 show ip',
      'privilege exec level 7 reload',
      'end',
    ]);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('privilege exec all level 5 show ip');
    expect(cfg).toContain('privilege exec level 7 reload');
    expect(cfg).not.toContain('privilege exec all level 7 reload');
  });

  it('`privilege exec reset` retire une regle posee avec `all`', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal',
      'privilege exec all level 5 show ip',
      'privilege exec reset show ip',
      'end',
    ]);
    expect(await r.executeCommand('show running-config')).not.toContain('privilege exec');
  });

  // ── Non-régression ────────────────────────────────────────────────
  it('une commande nommee explicitement reste accordee', async () => {
    const r = await lab([
      'privilege exec level 5 show running-config',
      'privilege exec level 5 show',
    ], 5);
    expect(await r.executeCommand('show running-config')).toContain('Building configuration');
  });

  it('sans aucune regle, tout se comporte comme avant', async () => {
    const r = await lab([]);
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('show ip route')).not.toContain(REFUS);
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
  });
});
