import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { bootFortiConsole, answerPrompt, answerSecret } from './fortiConsoleHarness';
import type { FortiTerminalSession } from '@/terminal/sessions';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (fgt: FortiGate, ...cmds: string[]) => cmds.reduce(
  (chain, cmd) => chain.then(() => fgt.executeCommand(cmd)),
  Promise.resolve(''),
);

async function machine(threshold = 3, duration = 60): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  await run(fgt,
    'config system admin', 'edit "admin"',
    'set password "Secret123!"', 'set accprofile "super_admin"', 'next', 'end',
    'config system global',
    `set admin-lockout-threshold ${threshold}`,
    `set admin-lockout-duration ${duration}`, 'end');
  return fgt;
}

async function essai(
  session: FortiTerminalSession, user: string, password: string,
): Promise<void> {
  await answerPrompt(session, user);
  await answerSecret(session, password);
}

function refus(session: FortiTerminalSession): number {
  return session.lines.filter(l => l.text.includes('Login incorrect')).length;
}

describe('le verrouillage compte les essais de la CONSOLE', () => {
  it('trois mots de passe faux verrouillent, et le BON est ensuite refuse', async () => {
    const fgt = await machine();
    const session = await bootFortiConsole(fgt);

    for (let i = 0; i < 3; i += 1) await essai(session, 'admin', 'FAUX');
    expect(fgt.adminIsLockedOut('admin')).toBe(true);

    await essai(session, 'admin', 'Secret123!');

    expect(refus(session)).toBe(4);
  });

  it('sous le seuil, le bon mot de passe passe — c\'est le temoin', async () => {
    const fgt = await machine();
    const session = await bootFortiConsole(fgt);

    for (let i = 0; i < 2; i += 1) await essai(session, 'admin', 'FAUX');
    await essai(session, 'admin', 'Secret123!');

    expect(refus(session)).toBe(2);
    expect(fgt.adminIsLockedOut('admin')).toBe(false);
  });

  it('un seuil de 0 est REFUSE — FortiOS accepte de 1 a 10', async () => {
    const fgt = await machine();

    expect(await fgt.executeCommand('config system global'))
      .not.toMatch(/Command fail/i);
    const refus_ = await fgt.executeCommand('set admin-lockout-threshold 0');
    await fgt.executeCommand('end');

    expect(refus_).toMatch(/Command fail|parse error/i);
  });

  it('un seuil eleve ne verrouille pas au troisieme essai', async () => {
    const fgt = await machine(10);
    const session = await bootFortiConsole(fgt);

    for (let i = 0; i < 5; i += 1) await essai(session, 'admin', 'FAUX');
    await essai(session, 'admin', 'Secret123!');

    expect(refus(session)).toBe(5);
    expect(fgt.adminIsLockedOut('admin')).toBe(false);
  });

  it('le verrou porte sur le COMPTE : un autre compte reste joignable', async () => {
    const fgt = await machine();
    await run(fgt, 'config system admin', 'edit "audit"',
      'set password "Audit123!"', 'set accprofile "super_admin"', 'next', 'end');
    const session = await bootFortiConsole(fgt);

    for (let i = 0; i < 3; i += 1) await essai(session, 'admin', 'FAUX');
    await essai(session, 'audit', 'Audit123!');

    expect(refus(session)).toBe(3);
    expect(fgt.adminIsLockedOut('audit')).toBe(false);
  });

  it('le verrou EXPIRE une fois la duree ecoulee', async () => {
    const fgt = await machine(3, 1);
    const session = await bootFortiConsole(fgt);

    for (let i = 0; i < 3; i += 1) await essai(session, 'admin', 'FAUX');
    expect(fgt.adminIsLockedOut('admin')).toBe(true);

    fgt.setLocalClock(fgt.localNow() + 2000);

    expect(fgt.adminIsLockedOut('admin')).toBe(false);
  });

  it('une connexion REUSSIE remet le compteur a zero', async () => {
    const fgt = await machine();
    const session = await bootFortiConsole(fgt);

    await essai(session, 'admin', 'FAUX');
    await essai(session, 'admin', 'FAUX');
    await essai(session, 'admin', 'Secret123!');

    expect(fgt.adminIsLockedOut('admin')).toBe(false);
  });
});
