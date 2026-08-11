import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { NetworkOsAccount } from '@/network/devices/router/aaa/NetworkOsAccount';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

interface Registre {
  open(i: Record<string, unknown>): { id: string; line: string } | null;
  close(id: string, reason?: string): unknown;
  formatDisplayUsers(): string;
  formatShowUsers(): string;
  setCurrentSession(id: string | null): void;
}

function registre(d: unknown): Registre {
  return (d as { getSshSessionRegistry(): Registre }).getSshSessionRegistry();
}

function commutateurHuawei(): HuaweiSwitch {
  const d = new HuaweiSwitch('SW1', 24, 0, 0);
  d.powerOn();
  return d;
}

describe('un commutateur Huawei tient ses sessions', () => {
  it('`display users` lit le registre au lieu d\'une constante', async () => {
    const d = commutateurHuawei();
    registre(d).open({ user: 'admin', fromIp: 'console', transport: 'console' });
    const out = await d.executeCommand('display users');
    expect(out, 'le nom de l\'operateur connecte').toContain('admin');
  }, 30_000);

  it('une console libre reste decrite comme libre', async () => {
    const d = commutateurHuawei();
    const out = await d.executeCommand('display users');
    expect(out).toContain('CON 0');
    expect(out).not.toContain('Username : admin');
  }, 30_000);

  it('une authentification reussie du magasin ouvre la session', async () => {
    const d = commutateurHuawei();
    d.getCredentialStore().upsert(NetworkOsAccount.create({ name: 'admin', privilege: 15 }));
    d.getCredentialStore().recordLoginSuccess('admin', 'console', 'password');
    const out = await d.executeCommand('display users');
    expect(out, 'la vue lit le registre, pas une constante').toContain('admin');
    expect(out).toContain('CON 0');
  }, 30_000);

  it('`local-user` declare un compte que le magasin porte', async () => {
    const d = commutateurHuawei();
    for (const c of ['system-view', 'aaa',
      'local-user admin password irreversible-cipher Huawei@123', 'quit', 'quit']) {
      await d.executeCommand(c);
    }
    expect(d.getCredentialStore().get('admin'),
      'un compte declare existe').toBeTruthy();
  }, 30_000);
});

describe('le rendu est celui de VRP, et il n\'y en a qu\'un', () => {
  it('l\'en-tete porte `User-Intf`, le mot que VRP ecrit', async () => {
    const d = commutateurHuawei();
    const out = await d.executeCommand('display users');
    expect(out).toContain('User-Intf');
    expect(out, '`UI` n\'est pas le mot de VRP').not.toMatch(/^\s*UI\s/m);
  }, 30_000);

  it('le nom d\'utilisateur est une LIGNE `Username :`, pas une colonne', () => {
    const d = commutateurHuawei();
    const r = registre(d);
    r.open({ user: 'admin', fromIp: 'console', transport: 'console' });
    const out = r.formatDisplayUsers();
    expect(out).toMatch(/^\s*Username : admin$/m);
    expect(out.split('\n')[0], 'pas de colonne User dans l\'en-tete').not.toContain('User ');
  }, 30_000);

  it('`AuthorcmdFlag` vaut `no`, et non `N`', () => {
    const d = commutateurHuawei();
    const r = registre(d);
    r.open({ user: 'admin', fromIp: 'console', transport: 'console' });
    const out = r.formatDisplayUsers();
    expect(out).toContain('no');
    expect(out).not.toMatch(/pass\s+N\s*$/m);
  }, 30_000);

  it('`+` marque l\'interface utilisateur COURANTE', () => {
    const d = commutateurHuawei();
    const r = registre(d);
    r.open({ user: 'admin', fromIp: 'console', transport: 'console' });
    const s = r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh' })!;
    r.setCurrentSession(s.id);
    const lignes = r.formatDisplayUsers().split('\n').filter((l) => l.startsWith('+'));
    expect(lignes, 'une seule courante').toHaveLength(1);
    expect(lignes[0]).toContain('VTY 0');
  }, 30_000);

  it('la console porte l\'interface 0, une VTY commence a 129', () => {
    const d = commutateurHuawei();
    const r = registre(d);
    r.open({ user: 'admin', fromIp: 'console', transport: 'console' });
    r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh' });
    const out = r.formatDisplayUsers();
    expect(out).toMatch(/^.\s+0\s+CON 0/m);
    expect(out).toMatch(/^.\s+129\s+VTY 0/m);
  }, 30_000);

  it('le routeur et le commutateur rendent le MEME format', () => {
    const rt = new HuaweiRouter('R1', 0, 0); rt.powerOn();
    const sw = commutateurHuawei();
    const entete = (d: unknown) => registre(d).formatDisplayUsers().split('\n')[0];
    expect(entete(sw), 'un seul rendu pour une seule commande').toBe(entete(rt));
  }, 30_000);

  it('une session SSH montre son adresse, une console n\'en a pas', () => {
    const d = commutateurHuawei();
    const r = registre(d);
    r.open({ user: 'carol', fromIp: '10.0.0.9', transport: 'ssh' });
    expect(r.formatDisplayUsers()).toContain('10.0.0.9');
    const c = commutateurHuawei();
    registre(c).open({ user: 'admin', fromIp: 'console', transport: 'console' });
    expect(registre(c).formatDisplayUsers()).not.toContain('console');
  }, 30_000);
});

describe('le commutateur Cisco tient les siennes aussi', () => {
  it('`show users` nomme l\'operateur de la console', async () => {
    const d = new CiscoSwitch('SW1', 24, 0, 0);
    d.powerOn();
    registre(d).open({ user: 'admin', fromIp: 'console', transport: 'console' });
    const out = await d.executeCommand('show users');
    expect(out).toContain('admin');
    expect(out).toContain('con 0');
  }, 30_000);

  it('sans session, `show users` decrit la console libre', async () => {
    const d = new CiscoSwitch('SW1', 24, 0, 0);
    d.powerOn();
    const out = await d.executeCommand('show users');
    expect(out).toContain('con 0');
    expect(out).toContain('Line       User');
  }, 30_000);
});
