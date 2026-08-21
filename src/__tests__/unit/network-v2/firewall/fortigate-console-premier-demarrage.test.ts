import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.clear();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

async function console_(fgt: FortiGate): Promise<FortiTerminalSession> {
  const s = new FortiTerminalSession('t1', fgt as never);
  await s.init();
  for (let i = 0; i < 40 && s.isBooting; i++) await tick();
  for (let i = 0; i < 10; i++) await tick();
  return s;
}

async function texte(s: FortiTerminalSession, valeur: string): Promise<void> {
  s.setInputBuf(valeur);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 25; i++) await tick();
}

async function commande(s: FortiTerminalSession, valeur: string): Promise<void> {
  s.setInput(valeur);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 30; i++) await tick();
}

async function secret(s: FortiTerminalSession, valeur: string): Promise<void> {
  s.setPasswordBuf(valeur);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 25; i++) await tick();
}

const vu = (s: FortiTerminalSession) => s.lines.map(l => l.text).join('\n');

describe('La console demande un login', () => {
  it('l invite porte le nom de la machine', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);

    const s = await console_(fgt);

    expect(s.currentInputMode.type).toBe('interactive-text');
    expect(JSON.stringify(s.currentInputMode)).toContain('FGT-01 login: ');
  });

  it('le mot de passe est demande, et masque', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await console_(fgt);

    await texte(s, 'admin');

    expect(s.currentInputMode.type).toBe('password');
    expect(JSON.stringify(s.currentInputMode)).toContain('Password: ');
  });

  it('un mauvais compte rend `Login incorrect` et redemande', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await console_(fgt);

    await texte(s, 'zorglub');
    await secret(s, 'peu importe');

    expect(vu(s)).toContain('Login incorrect');
    expect(s.currentInputMode.type).toBe('interactive-text');
  });

  it('la machine reste fermee tant que la porte n est pas passee', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await console_(fgt);

    await texte(s, 'zorglub');
    await secret(s, 'faux');
    await commande(s, 'get system status');

    expect(vu(s)).not.toContain('Version:');
  });
});

describe('Un FortiGate sorti d usine impose le changement de mot de passe', () => {
  it('le compte `admin` EXISTE, sans mot de passe', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);

    expect(fgt.adminNames()).toContain('admin');
    expect(fgt.authenticateAdmin('admin', '')).toBe(true);
    expect(fgt.adminMustChoosePassword('admin')).toBe(true);
    expect(await fgt.executeCommand('show system admin')).toContain('edit "admin"');
  });

  it('le dialogue est celui du vrai, mot pour mot', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await console_(fgt);

    await texte(s, 'admin');
    await secret(s, '');

    expect(vu(s)).toContain(
      'You are forced to change your password, please input a new password.');
    expect(JSON.stringify(s.currentInputMode)).toContain('New Password: ');
  });

  it('la confirmation est demandee, et le refus renvoie au debut', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await console_(fgt);
    await texte(s, 'admin');
    await secret(s, '');

    await secret(s, 'Fortinet123');
    expect(JSON.stringify(s.currentInputMode)).toContain('Confirm Password: ');
    await secret(s, 'AutreChose');

    expect(vu(s)).toContain('Passwords do not match.');
    expect(JSON.stringify(s.currentInputMode)).toContain('New Password: ');
  });

  it('deux fois le meme mot de passe ouvre la session', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await console_(fgt);
    await texte(s, 'admin');
    await secret(s, '');

    await secret(s, 'Fortinet123');
    await secret(s, 'Fortinet123');

    expect(vu(s)).toContain('Welcome !');
    expect(s.currentInputMode.type).toBe('normal');
  });

  it('le mot de passe choisi est CELUI du compte ensuite', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await console_(fgt);
    await texte(s, 'admin');
    await secret(s, '');
    await secret(s, 'Fortinet123');
    await secret(s, 'Fortinet123');

    expect(fgt.authenticateAdmin('admin', 'Fortinet123')).toBe(true);
    expect(fgt.authenticateAdmin('admin', '')).toBe(false);
    expect(fgt.adminMustChoosePassword('admin')).toBe(false);
  });

  it('la session ouverte execute pour de bon', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await console_(fgt);
    await texte(s, 'admin');
    await secret(s, '');
    await secret(s, 'Fortinet123');
    await secret(s, 'Fortinet123');

    await commande(s, 'get system status');

    expect(vu(s)).toContain('Version:');
  });

  it('une machine dont le mot de passe est pose n impose plus rien', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    for (const c of ['config system admin', 'edit "admin"',
      'set password "DejaPose1"', 'next', 'end']) {
      await fgt.executeCommand(c);
    }
    const s = await console_(fgt);

    await texte(s, 'admin');
    await secret(s, 'DejaPose1');

    expect(vu(s)).not.toContain('forced to change');
    expect(s.currentInputMode.type).toBe('normal');
  });
});
