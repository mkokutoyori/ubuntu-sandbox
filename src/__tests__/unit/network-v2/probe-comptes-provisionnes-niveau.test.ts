import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const touche = (k: string): KeyEvent => ({
  key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
});
const tick = () => new Promise<void>((r) => setTimeout(r, 15));

async function taper(s: CiscoTerminalSession, cmd: string): Promise<void> {
  s.setInput(cmd); s.handleKey(touche('Enter')); await tick();
}
async function texte(s: CiscoTerminalSession, v: string): Promise<void> {
  s.setInputBuf(v); s.handleKey(touche('Enter')); await tick();
}
async function motDePasse(s: CiscoTerminalSession, v: string): Promise<void> {
  s.setPasswordBuf(v); s.handleKey(touche('Enter')); await tick();
}

async function laboConsole(): Promise<{ d: CiscoRouter; s: CiscoTerminalSession }> {
  const d = new CiscoRouter('R1', 0, 0);
  d.powerOn();
  const s = new CiscoTerminalSession('t1', d);
  await s.init();
  for (let i = 0; i < 40; i++) { if (!s.isBooting) break; await tick(); }
  for (const c of ['enable', 'configure terminal', 'line console 0', 'login local', 'end']) {
    await taper(s, c);
  }
  await taper(s, 'exit');
  await taper(s, '');
  return { d, s };
}

const COMPTES = ['alice', 'bob', 'carl', 'dave'];

describe('un compte provisionne ouvre en EXEC UTILISATEUR', () => {
  it.each(COMPTES)('%s arrive sur `>` et non sur `#`', async (nom) => {
    const { s } = await laboConsole();
    await texte(s, nom);
    await motDePasse(s, nom);
    expect(s.getPrompt(), 'un compte sans privilege declare vaut niveau 1').toMatch(/>$/);
    expect(s.getPrompt()).not.toMatch(/#$/);
  }, 30_000);

  it.each(COMPTES)('%s a le niveau 1', async (nom) => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    expect(d.getCredentialStore().get(nom)?.privilege).toBe(1);
  }, 30_000);

  it('`enable` fait passer de `>` a `#`', async () => {
    const { s } = await laboConsole();
    await texte(s, 'alice');
    await motDePasse(s, 'alice');
    await taper(s, 'enable');
    expect(s.getPrompt()).toMatch(/#$/);
  }, 30_000);

  it('`disable` redescend de `#` a `>` sans fermer la session', async () => {
    const { s } = await laboConsole();
    await texte(s, 'alice');
    await motDePasse(s, 'alice');
    await taper(s, 'enable');
    const avant = s.lines.length;
    await taper(s, 'disable');
    expect(s.getPrompt()).toMatch(/>$/);
    expect(s.lines.slice(avant).map((l) => l.text).join('\n'),
      'la session tient toujours').not.toContain('con0 is now available');
  }, 30_000);

  it('`exit` depuis `>` libere la console', async () => {
    const { s } = await laboConsole();
    await texte(s, 'alice');
    await motDePasse(s, 'alice');
    await taper(s, 'exit');
    expect(s.lines.map((l) => l.text).join('\n')).toContain('con0 is now available');
  }, 30_000);

  it('`exit` depuis `#` libere la console, comme sur IOS', async () => {
    const { s } = await laboConsole();
    await texte(s, 'alice');
    await motDePasse(s, 'alice');
    await taper(s, 'enable');
    await taper(s, 'exit');
    expect(s.lines.map((l) => l.text).join('\n')).toContain('con0 is now available');
  }, 30_000);

  it('un compte eleve explicitement arrive bien sur `#`', async () => {
    const { d, s } = await laboConsole();
    await texte(s, 'alice');
    await motDePasse(s, 'alice');
    await taper(s, 'enable');
    await taper(s, 'configure terminal');
    await taper(s, 'username eve privilege 15 secret eve');
    await taper(s, 'end');
    expect(d.getCredentialStore().get('eve')?.privilege).toBe(15);
    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'eve');
    await motDePasse(s, 'eve');
    expect(s.getPrompt(), 'niveau 15 declare, donc EXEC privilegie').toMatch(/#$/);
  }, 30_000);
});

describe('cote Huawei, les memes comptes ouvrent en vue utilisateur', () => {
  it.each(COMPTES)('%s a le niveau 1 sur VRP', async (nom) => {
    const d = new HuaweiRouter('H1', 0, 0);
    d.powerOn();
    expect(d.getCredentialStore().get(nom)?.privilege).toBe(1);
  }, 30_000);
});

describe('la configuration decrit les comptes au bon niveau', () => {
  it('les comptes livres y figurent au niveau 1, et non 15', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    await d.executeCommand('enable');
    const rc = await d.executeCommand('show running-config');
    for (const nom of COMPTES) {
      expect(rc, nom).toContain(`username ${nom} `);
      // Le niveau 1 est le DEFAUT et IOS ne l'ecrit pas : toute clause
      // `privilege` sur ces comptes voudrait donc dire un autre niveau.
      expect(rc, `${nom} n'est pas un administrateur`)
        .not.toContain(`username ${nom} privilege`);
    }
  }, 30_000);

  it('un compte cree au niveau 1 y figure sans clause `privilege`', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    await d.executeCommand('enable');
    await d.executeCommand('configure terminal');
    await d.executeCommand('username mandeng privilege 1 secret x');
    await d.executeCommand('end');
    const rc = await d.executeCommand('show running-config');
    expect(rc).toMatch(/^username mandeng secret /m);
    expect(rc).not.toContain('username mandeng privilege');
  }, 30_000);

  it('elever un compte livre le rend au niveau 15', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    await d.executeCommand('enable');
    await d.executeCommand('configure terminal');
    await d.executeCommand('username alice privilege 15 secret nouveau');
    await d.executeCommand('end');
    expect(await d.executeCommand('show running-config')).toContain('username alice privilege 15');
  }, 30_000);
});

describe('`enable` sans mot de passe : la console passe, la vty non', () => {
  it('sur la console, `enable` monte a 15 — la machine est physiquement de confiance', async () => {
    const { s } = await laboConsole();
    await texte(s, 'alice');
    await motDePasse(s, 'alice');
    await taper(s, 'enable');
    expect(s.getPrompt()).toMatch(/#$/);
  }, 30_000);

  it('sur une vty, `enable` est refuse par `% No password set`', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    const shell = (d as unknown as {
      getShell(): {
        interactionPlanFor(c: string, ctx: Record<string, unknown>):
          { steps: Array<{ kind: string; lines?: string[] }> } | null;
      };
    }).getShell();
    const plan = shell.interactionPlanFor('enable', { onVtyLine: true, mode: 'user' });
    expect(plan, 'une vty a un plan de refus').toBeTruthy();
    expect(JSON.stringify(plan), 'une ligne reseau n\'offre pas le mode privilegie')
      .toContain('% No password set');
  }, 30_000);
});
