/**
 * `privilege level N` sur une ligne ouvre la session A CE NIVEAU.
 *
 * Deux defauts mesures (audit §3, M1 et M2), et ils se tenaient :
 *
 * M1 — la regle etait appliquee par UNE porte sur deux.
 * `CiscoTerminalSession` la lisait, et correctement ; `Router.loginAs`
 * lisait le niveau du COMPTE et ignorait la ligne. Toute session non
 * issue du terminal graphique — SSH, telnet, script, import de topologie
 * — ouvrait donc au mauvais niveau.
 *
 * M2 — le reglage de la console vivait sur le SHELL, alors que celui des
 * vty vit sur l'equipement. Or `createVtyShell()` construit un shell
 * NEUF par session : `line console 0 / privilege level 15` tape depuis
 * une session SSH se rangeait sur le shell de cette session et
 * disparaissait avec elle. La console n'en savait rien.
 *
 * La precedence est celle que Cisco documente, et que le commentaire de
 * `CiscoTerminalSession` citait deja : AAA > ligne > compte. Le niveau
 * de la ligne est un REMPLACEMENT, pas un plancher — il vaut aussi
 * quand il est INFERIEUR a celui du compte, ce qu'un seul des cas
 * ci-dessous aurait laisse passer.
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

async function jouer(r: CiscoRouter, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await r.executeCommand(c);
  return derniere;
}

async function lab(lignesConsole: string[], niveauCompte = 1): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', MACAddress.generate());
  await jouer(r, [
    'enable', 'configure terminal',
    `username joe privilege ${niveauCompte} secret joe`,
    'line console 0', 'login local', ...lignesConsole, 'exit',
    'end', 'exit',
  ]);
  return r;
}

const niveau = (r: CiscoRouter) => r.executeCommand('show privilege');

describe('M1 — le niveau de la ligne s applique par TOUTES les portes', () => {
  it('`privilege level 15` ouvre la session au niveau 15', async () => {
    const r = await lab(['privilege level 15'], 1);
    expect(await r.loginAs('joe', 'joe')).toBe(true);
    expect(await niveau(r)).toContain('level is 15');
  });

  it('le niveau de la ligne REMPLACE celui du compte, meme vers le BAS', async () => {
    const r = await lab(['privilege level 3'], 15);
    expect(await r.loginAs('joe', 'joe')).toBe(true);
    expect(await niveau(r)).toContain('level is 3');
  });

  it('`no privilege level` rend la main au compte', async () => {
    const r = await lab(['privilege level 15'], 7);
    await jouer(r, [
      'enable', 'configure terminal', 'line console 0', 'no privilege level',
      'exit', 'end', 'exit',
    ]);
    expect(await r.loginAs('joe', 'joe')).toBe(true);
    expect(await niveau(r)).toContain('level is 7');
  });

  it('sans reglage de ligne, le compte decide', async () => {
    const r = await lab([], 9);
    expect(await r.loginAs('joe', 'joe')).toBe(true);
    expect(await niveau(r)).toContain('level is 9');
  });

  it('le niveau ouvre bien le mode qui va avec', async () => {
    const r = await lab(['privilege level 15'], 1);
    await r.loginAs('joe', 'joe');
    expect(await r.executeCommand('configure terminal'))
      .toContain('Enter configuration commands');
  });
});

describe('M2 — le reglage de la ligne appartient a l EQUIPEMENT', () => {
  it('tape depuis une session vty, il vaut pour la CONSOLE', async () => {
    const r = await lab([], 1);
    const vty = r.createVtyShell('admin');
    for (const c of ['enable', 'configure terminal', 'line console 0',
      'privilege level 15', 'exit', 'end']) {
      await vty.execute(c);
    }
    vty.dispose();

    expect(await r.loginAs('joe', 'joe')).toBe(true);
    expect(await niveau(r)).toContain('level is 15');
  });

  it('il survit a la disparition du shell qui l a pose', async () => {
    const r = await lab([], 1);
    const vty = r.createVtyShell('admin');
    for (const c of ['enable', 'configure terminal', 'line console 0',
      'privilege level 12', 'exit', 'end']) {
      await vty.execute(c);
    }
    vty.dispose();
    await jouer(r, ['enable']);
    expect(await r.executeCommand('show running-config'))
      .toMatch(/^line console 0\n(?: .*\n)* privilege level 12$/m);
  });

  it('il se relit apres un aller-retour de configuration', async () => {
    const r = await lab(['privilege level 15'], 1);
    await jouer(r, ['enable']);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain(' privilege level 15');

    const r2 = new CiscoRouter('R2', MACAddress.generate());
    await jouer(r2, [
      'enable', 'configure terminal',
      'username joe privilege 1 secret joe',
      'line console 0', 'login local', 'privilege level 15', 'exit',
      'end', 'exit',
    ]);
    expect(await r2.loginAs('joe', 'joe')).toBe(true);
    expect(await niveau(r2)).toContain('level is 15');
  });
});
