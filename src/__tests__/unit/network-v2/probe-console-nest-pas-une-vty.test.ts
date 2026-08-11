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

async function routeur(): Promise<CiscoRouter> {
  const d = new CiscoRouter('Router1', 0, 0);
  d.powerOn();
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  await d.executeCommand('username alice privilege 15 secret cisco');
  await d.executeCommand('username bob privilege 15 secret cisco');
  await d.executeCommand('line console 0');
  await d.executeCommand('login local');
  await d.executeCommand('end');
  return d;
}

function registre(d: CiscoRouter) {
  return (d as unknown as {
    getSshSessionRegistry(): {
      open(i: Record<string, unknown>): { id: string; line: string } | null;
      close(id: string, reason?: string): unknown;
      formatShowUsers(now?: number): string;
      list(): ReadonlyArray<{ line: string; transport: string; fromIp: string }>;
      setCurrentSession(id: string | null): void;
    };
  }).getSshSessionRegistry();
}

function journal(d: CiscoRouter): string {
  return d.getLoggingConfig()!.render();
}

describe('la console ouvre une session console, pas une vty', () => {
  it('un login console n\'emet AUCUN message SSH', async () => {
    const d = await routeur();
    d.getCredentialStore().recordLoginSuccess('alice', 'console', 'password');
    const j = journal(d);
    expect(j, 'SSH ne parle pas pour la console').not.toContain('SSH2_SESSION');
    expect(j, 'ni la contradiction « on vty … from console »').not.toMatch(/vty \d+ from console/);
  }, 30_000);

  it('un login SSH emet bien le message SSH', async () => {
    const d = await routeur();
    registre(d).open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh', localPort: 22 });
    expect(journal(d), 'le vrai cas SSH n\'est pas perdu').toContain('SSH2_SESSION');
  }, 30_000);

  it('la ligne de la console est `con 0`, pas `vty 0`', async () => {
    const d = await routeur();
    d.getCredentialStore().recordLoginSuccess('alice', 'console', 'password');
    const sessions = registre(d).list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].line).toBe('con 0');
    expect(sessions[0].transport).toBe('console');
  }, 30_000);

  it('deux logins console successifs restent sur `con 0` — il n\'y en a qu\'une', async () => {
    const d = await routeur();
    const r = registre(d);
    const a = r.open({ user: 'alice', fromIp: 'console', transport: 'console' })!;
    r.close(a.id, 'logout');
    const b = r.open({ user: 'bob', fromIp: 'console', transport: 'console' })!;
    expect(b.line, 'la console ne se numerote pas').toBe('con 0');
  }, 30_000);

  it('une seconde console est REFUSEE tant que la premiere tient', async () => {
    const d = await routeur();
    const r = registre(d);
    expect(r.open({ user: 'alice', fromIp: 'console', transport: 'console' })).not.toBeNull();
    expect(r.open({ user: 'bob', fromIp: 'console', transport: 'console' }),
      'un routeur n\'a qu\'un port console').toBeNull();
  }, 30_000);

  it('SSH et telnet prennent une vty, la console n\'en consomme aucune', async () => {
    const d = await routeur();
    const r = registre(d);
    r.open({ user: 'alice', fromIp: 'console', transport: 'console' });
    const s = r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh' })!;
    expect(s.line, 'la console n\'a pas mange la vty 0').toBe('vty 0');
    const t = r.open({ user: 'dave', fromIp: '10.0.0.8', transport: 'telnet' })!;
    expect(t.line).toBe('vty 1');
  }, 30_000);
});

describe('`show users` decrit la ligne et marque la session courante', () => {
  it('la console apparait en `con 0` avec une Location VIDE', async () => {
    const d = await routeur();
    const r = registre(d);
    r.open({ user: 'alice', fromIp: 'console', transport: 'console' });
    const out = r.formatShowUsers();
    expect(out).toMatch(/con 0/);
    expect(out, 'une console n\'a pas d\'adresse d\'origine').not.toContain('console\n');
    expect(out).not.toMatch(/vty/);
  }, 30_000);

  it('`*` marque la session COURANTE et non la premiere de la liste', async () => {
    const d = await routeur();
    const r = registre(d);
    r.open({ user: 'alice', fromIp: 'console', transport: 'console' });
    const carol = r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh' })!;
    r.setCurrentSession(carol.id);
    const lignes = r.formatShowUsers().split('\n').slice(1);
    const marquee = lignes.filter((l) => l.trimStart().startsWith('*'));
    expect(marquee, 'une seule session courante').toHaveLength(1);
    expect(marquee[0]).toContain('carol');
  }, 30_000);

  it('une session fermee disparait de `show users`', async () => {
    const d = await routeur();
    const r = registre(d);
    const a = r.open({ user: 'alice', fromIp: 'console', transport: 'console' })!;
    r.close(a.id, 'logout');
    expect(r.formatShowUsers()).not.toContain('alice');
  }, 30_000);

  it('la Location d\'une session SSH est son adresse', async () => {
    const d = await routeur();
    const r = registre(d);
    r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh' });
    expect(r.formatShowUsers()).toContain('10.0.0.9');
  }, 30_000);
});

describe('l\'historique appartient a la session EXEC', () => {
  it('fermer la session EXEC vide l\'historique', async () => {
    const d = await routeur();
    await d.executeCommand('enable');
    await d.executeCommand('show version');
    expect(await d.executeCommand('show history')).toContain('show version');
    await d.executeCommand('exit');
    await d.executeCommand('enable');
    const h = await d.executeCommand('show history');
    expect(h, 'la session suivante ne relit pas la precedente').not.toContain('show version');
  }, 30_000);

  it('ouvrir une session EXEC pour un utilisateur part d\'un historique vide', async () => {
    const d = await routeur();
    await d.executeCommand('enable');
    await d.executeCommand('show clock');
    const shell = (d as unknown as {
      shell: { beginExecSession?: (n: number, u?: string) => void };
    }).shell;
    shell.beginExecSession?.(15, 'bob');
    expect(await d.executeCommand('show history')).not.toContain('show clock');
  }, 30_000);
});

const touche = (k: string): KeyEvent => ({
  key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
});
const tick = () => new Promise<void>((r) => setTimeout(r, 15));

async function attendreDemarrage(s: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 40; i++) { if (!s.isBooting) return; await tick(); }
}
async function taper(s: CiscoTerminalSession, cmd: string): Promise<void> {
  s.setInput(cmd); s.handleKey(touche('Enter')); await tick();
}
async function texte(s: CiscoTerminalSession, v: string): Promise<void> {
  s.setInputBuf(v); s.handleKey(touche('Enter')); await tick();
}
async function motDePasse(s: CiscoTerminalSession, v: string): Promise<void> {
  s.setPasswordBuf(v); s.handleKey(touche('Enter')); await tick();
}
function ecran(s: CiscoTerminalSession): string {
  return s.lines.map((l) => l.text).join('\n');
}

async function labo(): Promise<{ d: CiscoRouter; s: CiscoTerminalSession }> {
  const d = new CiscoRouter('Router1', 0, 0);
  d.powerOn();
  const s = new CiscoTerminalSession('t1', d);
  await s.init();
  await attendreDemarrage(s);
  for (const c of ['enable', 'configure terminal',
    'username alice privilege 15 secret cisco',
    'username bob privilege 15 secret cisco',
    'line console 0', 'login local', 'end']) {
    await taper(s, c);
  }
  return { d, s };
}

describe('le transcript rejoue par le terminal', () => {
  it('un login console n\'ecrit AUCUN %SSH-6-SSH2_SESSION a l\'ecran', async () => {
    const { s } = await labo();
    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'alice');
    await motDePasse(s, 'cisco');
    const vu = ecran(s);
    expect(vu).not.toContain('SSH2_SESSION');
    expect(vu).not.toMatch(/on vty \d+ from console/);
  }, 30_000);

  it('`show users` place l\'operateur sur `con 0`', async () => {
    const { s } = await labo();
    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'alice');
    await motDePasse(s, 'cisco');
    await taper(s, 'show users');
    const vu = ecran(s);
    expect(vu).toMatch(/con 0/);
    expect(vu, 'la console n\'est pas une ligne virtuelle').not.toMatch(/\d+ vty \d+ +alice/);
  }, 30_000);

  it('l\'operateur precedent disparait de `show users` apres son `exit`', async () => {
    const { d, s } = await labo();
    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'alice');
    await motDePasse(s, 'cisco');
    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'bob');
    await motDePasse(s, 'cisco');
    await taper(s, 'show users');
    const vu = ecran(s).split('show users')[1] ?? '';
    expect(vu, 'bob est la').toContain('bob');
    expect(vu, 'alice est partie').not.toContain('alice');
    expect(registre(d).list()).toHaveLength(1);
  }, 30_000);

  it('chaque operateur voit SES commandes, et seulement les siennes', async () => {
    const { s } = await labo();
    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'alice');
    await motDePasse(s, 'cisco');
    await taper(s, 'show clock');
    const avantAlice = s.lines.length;
    await taper(s, 'show history');
    const chezAlice = s.lines.slice(avantAlice).map((l) => l.text).join('\n');
    expect(chezAlice, 'alice relit sa propre commande').toContain('show clock');

    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'bob');
    await motDePasse(s, 'cisco');
    const avantBob = s.lines.length;
    await taper(s, 'show history');
    const chezBob = s.lines.slice(avantBob).map((l) => l.text).join('\n');
    expect(chezBob, 'la commande d\'alice n\'appartient pas a bob')
      .not.toContain('show clock');
    expect(chezBob, 'ni ce qui a ete tape avant l\'authentification')
      .not.toContain('login local');
  }, 30_000);
});

describe('cote Huawei, `display users` nomme la ligne CON', () => {
  it('une session console est rendue `CON`, une session SSH `SSH`', async () => {
    const d = new HuaweiRouter('H1', 0, 0);
    d.powerOn();
    const r = (d as unknown as {
      getSshSessionRegistry(): {
        open(i: Record<string, unknown>): unknown;
        formatDisplayUsers(): string;
      };
    }).getSshSessionRegistry();
    r.open({ user: 'alice', fromIp: 'console', transport: 'console' });
    expect(r.formatDisplayUsers()).toContain('CON');
    r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh' });
    const out = r.formatDisplayUsers();
    expect(out).toContain('SSH');
    expect(out).toContain('10.0.0.9');
  }, 30_000);

  it('la console Huawei ne consomme pas de VTY non plus', async () => {
    const d = new HuaweiRouter('H1', 0, 0);
    d.powerOn();
    const r = (d as unknown as {
      getSshSessionRegistry(): {
        open(i: Record<string, unknown>): { line: string } | null;
      };
    }).getSshSessionRegistry();
    r.open({ user: 'alice', fromIp: 'console', transport: 'console' });
    expect(r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh' })!.line).toBe('vty 0');
  }, 30_000);
});

function lignesSsh(d: CiscoRouter): string[] {
  return d.getLoggingConfig()!.render().split('\n').filter((l) => /%SSH-/.test(l));
}

describe('aucune notification SSH ne sort pour ce qui n\'est pas SSH', () => {
  it('ouvrir ET fermer une session console n\'ecrit aucun `%SSH-`', async () => {
    const d = await routeur();
    const r = registre(d);
    const s = r.open({ user: 'alice', fromIp: 'console', transport: 'console' })!;
    r.close(s.id, 'logout');
    expect(lignesSsh(d), 'la console ne concerne pas le sous-systeme SSH').toEqual([]);
  }, 30_000);

  it('le depart reste annonce, par `%SYS-6-LOGOUT`', async () => {
    const d = await routeur();
    const r = registre(d);
    const s = r.open({ user: 'alice', fromIp: 'console', transport: 'console' })!;
    r.close(s.id, 'logout');
    expect(d.getLoggingConfig()!.render(),
      'taire SSH ne doit pas taire le depart').toContain('%SYS-6-LOGOUT: User alice');
  }, 30_000);

  it('une session telnet non plus', async () => {
    const d = await routeur();
    const r = registre(d);
    const s = r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'telnet' })!;
    r.close(s.id, 'logout');
    expect(lignesSsh(d), 'telnet n\'est pas SSH').toEqual([]);
  }, 30_000);

  it('une session SSH ecrit les DEUX messages, dans les mots d\'IOS', async () => {
    const d = await routeur();
    const r = registre(d);
    const s = r.open({ user: 'alice', fromIp: '10.0.0.5', transport: 'ssh' })!;
    r.close(s.id, 'logout');
    const l = lignesSsh(d);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatch(
      /%SSH-5-SSH2_SESSION: SSH2 Session request from 10\.0\.0\.5 \(tty = 0\) using crypto cipher '[^']+', hmac '[^']+' Succeeded$/);
    expect(l[1]).toMatch(
      /%SSH-5-SSH2_CLOSE: SSH2 Session from 10\.0\.0\.5 \(tty = 0\) for user 'alice' using crypto cipher '[^']+', hmac '[^']+' closed$/);
  }, 30_000);

  it('la formulation inventee a disparu des deux cotes', async () => {
    const d = await routeur();
    const r = registre(d);
    const s = r.open({ user: 'alice', fromIp: '10.0.0.5', transport: 'ssh' })!;
    r.close(s.id, 'logout');
    const j = d.getLoggingConfig()!.render();
    expect(j).not.toContain('Session opened for');
    expect(j).not.toContain('Session closed for');
    expect(j, 'ni le message emis a l\'acceptation TCP').not.toContain('AUTHENTICATION: SSH connection');
  }, 30_000);

  it('une session SSH fermee ne parle jamais d\'une ligne console', async () => {
    const d = await routeur();
    const r = registre(d);
    const c = r.open({ user: 'alice', fromIp: 'console', transport: 'console' })!;
    const s = r.open({ user: 'carol', fromIp: '10.0.0.5', transport: 'ssh' })!;
    r.close(c.id, 'logout');
    r.close(s.id, 'logout');
    for (const l of lignesSsh(d)) expect(l, l).not.toMatch(/con 0|console/);
  }, 30_000);
});

describe('le transcript, cote notifications', () => {
  it('le parcours complet de la console n\'affiche aucun `%SSH-`', async () => {
    const { d, s } = await labo();
    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'alice');
    await motDePasse(s, 'cisco');
    await taper(s, 'configure terminal');
    await taper(s, 'interface gi0/0');
    await taper(s, 'no shutdown');
    await taper(s, 'end');
    await taper(s, 'exit');
    await taper(s, '');
    await texte(s, 'bob');
    await motDePasse(s, 'cisco');
    expect(ecran(s), 'rien de SSH a l\'ecran').not.toMatch(/%SSH-/);
    expect(lignesSsh(d), 'ni dans le journal').toEqual([]);
  }, 30_000);
});
