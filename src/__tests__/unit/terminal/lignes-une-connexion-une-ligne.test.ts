/**
 * Une connexion a un equipement reseau occupe une LIGNE — docs/PRD-Lignes-Terminal.md.
 *
 * Discrimination par restauration des onze fichiers de production :
 * 16 des 17 cas tombent avant correctif, le dix-septieme etant le cas de
 * non-regression (« un hote Linux garde plusieurs terminaux »), dont
 * c'est l'objet de passer des deux cotes.
 *
 * Deux de ces seize ne prouvent PAS ce que leur nom annonce, et cela est
 * dit ici plutot que laisse a decouvrir : « line vty 0 1 laisse deux vty »
 * et « clear line d'une ligne libre ne coupe rien » decrivent un
 * comportement qui etait DEJA juste ; ils tombent seulement parce qu'ils
 * lisent le pool par l'accesseur que ce lot ajoute. Le pool borne etait
 * la avant, mesure contre un premier essai de sonde qui avait oublie
 * `enable`, concluait a tort a un defaut, et aurait fait « corriger »
 * une regle qui fonctionnait.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import { getSessionRegistry } from '@/network/equipment/RouterServiceCapabilities';

const tick = () => new Promise((r) => setTimeout(r, 0));

let bus: EventBus;
let manager: TerminalManager;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);
  manager = new TerminalManager(bus);
});

async function openCisco(name = 'R1'): Promise<{ router: CiscoRouter; id: string; session: CiscoTerminalSession }> {
  const router = new CiscoRouter(name);
  router.setEventBus(bus);
  const id = manager.openTerminal(router);
  expect(id).not.toBeNull();
  const session = manager.getSession(id!) as CiscoTerminalSession;
  for (let i = 0; i < 60 && session.isBooting; i++) await tick();
  return { router, id: id!, session };
}

function lines(router: unknown): string[] {
  return (getSessionRegistry(router)?.list() ?? []).map((s) => s.line);
}

describe('une fenetre de terminal occupe une ligne reelle', () => {
  it('la premiere fenetre prend con 0 et le registre la connait', async () => {
    const { router } = await openCisco();
    expect(lines(router)).toEqual(['con 0']);
  });

  it('show users montre la session, et non une ligne codee en dur', async () => {
    const { router } = await openCisco();
    const avecTerminal = await router.executeCommand('show users');
    expect(avecTerminal).toMatch(/^\s*\*?\s*0 con 0/m);

    const autre = new CiscoRouter('R2');
    autre.setEventBus(bus);
    const sansTerminal = await autre.executeCommand('show users');
    expect(sansTerminal).not.toMatch(/con 0/);
  });

  it('show line compte l utilisation de la CTY', async () => {
    const { router } = await openCisco();
    const table = await router.executeCommand('show line');
    const cty = table.split('\n').find((l) => l.includes('CTY'));
    expect(cty).toBeDefined();
    expect(cty!.trim().split(/\s+/).filter((c) => c === '1').length).toBeGreaterThan(0);
  });

  it('la session console ne se declare plus vty', async () => {
    const { session } = await openCisco();
    expect(session.vty?.lineId).toBe('con 0');
    expect(session.vty?.lineKind).toBe('con');
    expect(session.vty?.lineIndex).toBe(0);
  });

  it('une seconde fenetre rend la premiere : un chassis n a qu un port console', async () => {
    const { router, id } = await openCisco();
    const second = manager.openTerminal(router);
    expect(second).toBe(id);
    expect(manager.getSessionsForDevice(router.getId())).toHaveLength(1);
    expect(lines(router)).toEqual(['con 0']);
  });

  it('fermer la fenetre libere la ligne, et une nouvelle reprend con 0', async () => {
    const { router, id } = await openCisco();
    manager.closeTerminal(id);
    expect(lines(router)).toEqual([]);

    const repris = manager.openTerminal(router);
    expect(repris).not.toBeNull();
    expect(lines(router)).toEqual(['con 0']);
  });

  it('un hote Linux garde plusieurs terminaux', () => {
    const pc = new LinuxPC('PC1');
    pc.setEventBus(bus);
    const a = manager.openTerminal(pc);
    const b = manager.openTerminal(pc);
    expect(a).not.toBe(b);
    expect(manager.getSessionsForDevice(pc.getId())).toHaveLength(2);
  });
});

describe('le pool vty borne les sessions entrantes', () => {
  it('line vty 0 1 laisse deux vty et refuse la troisieme', async () => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('line vty 0 1');
    await router.executeCommand('exit');
    await router.executeCommand('exit');
    const registry = getSessionRegistry(router)!;
    expect(registry.open({ user: 'a', fromIp: '10.0.0.9', transport: 'ssh' })?.line).toBe('vty 0');
    expect(registry.open({ user: 'b', fromIp: '10.0.0.9', transport: 'ssh' })?.line).toBe('vty 1');
    expect(registry.open({ user: 'c', fromIp: '10.0.0.9', transport: 'ssh' })).toBeNull();
    expect(registry.hasFreeLine('vty')).toBe(false);
  });
});

describe('clear line coupe la ligne que show users designe', () => {
  async function labo() {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    const registry = getSessionRegistry(router)!;
    registry.open({ user: 'operateur', fromIp: '', transport: 'console' });
    registry.open({ user: 'u0', fromIp: '10.0.0.9', transport: 'ssh' });
    registry.open({ user: 'u1', fromIp: '10.0.0.9', transport: 'ssh' });
    return { router, registry };
  }

  it('clear line 2 coupe vty 0, la ligne que la colonne Line nomme 2', async () => {
    const { router, registry } = await labo();
    const table = await router.executeCommand('show users');
    expect(table).toMatch(/2 vty 0\s+u0/);

    expect(await router.executeCommand('clear line 2')).toBe('[confirm]\n [OK]');
    expect(registry.list().map((s) => s.line)).toEqual(['con 0', 'vty 1']);
  });

  it('clear line vty 0 ne touche pas la console', async () => {
    const { router, registry } = await labo();
    await router.executeCommand('clear line vty 0');
    expect(registry.list().map((s) => s.line)).toContain('con 0');
    expect(registry.list().map((s) => s.line)).not.toContain('vty 0');
  });

  it('la console se coupe depuis une autre ligne', async () => {
    const { router, registry } = await labo();
    expect(await router.executeCommand('clear line con 0')).toBe('[confirm]\n [OK]');
    expect(registry.list().map((s) => s.line)).not.toContain('con 0');
  });

  it('on ne coupe pas la ligne sur laquelle on est', async () => {
    const { router, registry } = await labo();
    const courante = registry.list().find((s) => s.id === registry.currentSession());
    expect(courante?.line).toBe('vty 1');
    expect(await router.executeCommand('clear line 3')).toBe('% Not allowed to clear current line');
    expect(registry.list().map((s) => s.line)).toContain('vty 1');
  });

  it('clear line d une ligne libre ne coupe rien', async () => {
    const { router, registry } = await labo();
    expect(await router.executeCommand('clear line vty 4')).toBe('[confirm]');
    expect(registry.list()).toHaveLength(3);
  });

  it('la fenetre dont la ligne est coupee est deconnectee', async () => {
    const { router, session } = await openCisco();
    const registry = getSessionRegistry(router)!;
    registry.open({ user: 'admin', fromIp: '10.0.0.9', transport: 'ssh' });
    await router.executeCommand('enable');
    await router.executeCommand('clear line 0');
    expect(session.isDisconnected).toBe(true);
  });
});

describe('VRP decrit ses user-interfaces depuis le pool reel', () => {
  it('display user-interface suit la capacite configuree et une seule numerotation', async () => {
    const router = new HuaweiRouter('AR1');
    router.setEventBus(bus);
    await router.executeCommand('system-view');
    await router.executeCommand('user-interface vty 0 9');
    await router.executeCommand('quit');
    const table = await router.executeCommand('display user-interface');
    const vty = table.split('\n').filter((l) => l.includes('VTY'));
    expect(vty).toHaveLength(10);
    expect(vty[0]).toMatch(/^\s+129\s+VTY 0/);
  });

  it('le marqueur de ligne courante vient du registre, pas d une constante', async () => {
    const router = new HuaweiRouter('AR1');
    router.setEventBus(bus);
    const sansPersonne = await router.executeCommand('display user-interface');
    expect(sansPersonne.split('\n').find((l) => l.includes('CON 0'))).toMatch(/^\s{2}0/);

    const id = manager.openTerminal(router);
    const session = manager.getSession(id!) as unknown as { isBooting: boolean };
    for (let i = 0; i < 60 && session.isBooting; i++) await tick();
    const avec = await router.executeCommand('display user-interface');
    expect(avec.split('\n').find((l) => l.includes('CON 0'))).toMatch(/^\+ 0/);
  });

  it('free user-interface libere une vty et refuse la ligne courante', async () => {
    const router = new HuaweiRouter('AR1');
    router.setEventBus(bus);
    const registry = getSessionRegistry(router)!;
    registry.open({ user: 'a', fromIp: '10.0.0.9', transport: 'ssh' });
    const courante = registry.open({ user: 'b', fromIp: '10.0.0.9', transport: 'ssh' })!;
    expect(registry.currentSession()).toBe(courante.id);

    expect(await router.executeCommand('free user-interface vty 0'))
      .toBe('Warning: User interface VTY0 will be freed. Do you want to continue? [Y/N]:y\n'
        + 'Info: User interface VTY0 is free.');
    expect(registry.list().map((s) => s.line)).toEqual(['vty 1']);

    expect(await router.executeCommand('free user-interface 130'))
      .toBe('Error: The user interface VTY1 is the current user interface.');
  });
});
