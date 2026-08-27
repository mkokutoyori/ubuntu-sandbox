import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function taper(d: FortiGate, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

describe('TP 2 — rendre son FortiGate identifiable et a l\'heure', () => {
  it('etape 1 : `set hostname` ne change l\'invite qu\'au `end`', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FortiGate-VM64', 0, 0);
    await fgt.executeCommand('config system global');
    expect(fgt.getPrompt()).toBe('FortiGate-VM64 (global) # ');
    await fgt.executeCommand('set hostname FGT-01');
    expect(fgt.getPrompt()).toBe('FortiGate-VM64 (global) # ');
    await fgt.executeCommand('end');
    expect(fgt.getPrompt()).toBe('FGT-01 # ');
  });

  it('etape 1b : `abort` laisse le nom d\'avant', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FortiGate-VM64', 0, 0);
    await taper(fgt, ['config system global', 'set hostname FGT-01', 'abort']);

    expect(fgt.getPrompt()).toBe('FortiGate-VM64 # ');
  });

  it('etape 2 : le fuseau se pose par NUMERO et par NOM normalise', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    propre(await taper(fgt, ['config system global', 'set timezone 04', 'end']));
    expect(await fgt.executeCommand('show system global')).toMatch(/set timezone /);

    propre(await taper(fgt, [
      'config system global', 'set timezone "Europe/Paris"', 'end',
    ]));
    expect(await fgt.executeCommand('show system global')).toContain('Europe/Paris');
  });

  it('etape 2 : le fuseau DEPLACE vraiment l\'heure rendue', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await taper(fgt, ['config system global', 'set timezone "Europe/Paris"', 'end']);
    await fgt.executeCommand('execute time 12:00:00');
    const paris = await fgt.executeCommand('execute time');

    await taper(fgt, ['config system global', 'set timezone "America/New_York"', 'end']);
    const newYork = await fgt.executeCommand('execute time');

    expect(paris).toMatch(/current time is: 12:00:\d{2}/);
    expect(newYork).not.toMatch(/current time is: 12:00:/);
    expect(newYork).toMatch(/current time is: 0[5-7]:00:\d{2}/);
  });

  it('etape 2 : un fuseau inexistant est REFUSE', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await fgt.executeCommand('config system global');
    const out = await fgt.executeCommand('set timezone "Mars/Olympus"');
    expect(out).toMatch(/parse error|Invalid|value parse error/i);
    await fgt.executeCommand('end');
  });

  it('etape 3 : la table NTP imbriquee est acceptee mot pour mot', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    propre(await taper(fgt, [
      'config system ntp',
      'set ntpsync enable',
      'set type custom',
      'config ntpserver',
      'edit 1',
      'set server "fr.pool.ntp.org"',
      'next',
      'end',
      'set syncinterval 60',
      'end',
    ]));
    const conf = await fgt.executeCommand('show system ntp');
    expect(conf).toContain('set ntpsync enable');
    expect(conf).toContain('set type custom');
    expect(conf).toContain('fr.pool.ntp.org');
    expect(conf).toContain('set syncinterval 60');
  });

  it('etape 3 : l\'invite suit la table IMBRIQUEE', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await fgt.executeCommand('config system ntp');
    expect(fgt.getPrompt()).toBe('FGT-01 (ntp) # ');
    await fgt.executeCommand('config ntpserver');
    expect(fgt.getPrompt()).toBe('FGT-01 (ntpserver) # ');
    await fgt.executeCommand('edit 1');
    expect(fgt.getPrompt()).toBe('FGT-01 (1) # ');
    await fgt.executeCommand('next');
    expect(fgt.getPrompt()).toBe('FGT-01 (ntpserver) # ');
    await fgt.executeCommand('end');
    expect(fgt.getPrompt()).toBe('FGT-01 (ntp) # ');
    await fgt.executeCommand('end');
    expect(fgt.getPrompt()).toBe('FGT-01 # ');
  });

  it('etape 4 : `execute time` et `execute date` LISENT l\'heure', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    expect(await fgt.executeCommand('execute time')).toMatch(/current time is: \d{2}:\d{2}:\d{2}/);
    expect(await fgt.executeCommand('execute date')).toMatch(/current date is: \d{4}-\d{2}-\d{2}/);
  });

  it('etape 4 : `execute time` REGLE l\'heure, et `get system status` la relit', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    propre(await taper(fgt, ['execute time 14:30:00']));
    expect(await fgt.executeCommand('execute time')).toMatch(/current time is: 14:30:\d{2}/);
    expect(await fgt.executeCommand('get system status')).toMatch(/System time: .*14:30/);
  });

  it('etape 4 : `diagnose sys ntp status` rend un etat de synchronisation', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await taper(fgt, [
      'config system ntp', 'set ntpsync enable', 'set type custom',
      'config ntpserver', 'edit 1', 'set server "fr.pool.ntp.org"', 'next', 'end',
      'end',
    ]);
    const out = await fgt.executeCommand('diagnose sys ntp status');
    expect(out).not.toMatch(/Unknown action/i);
    expect(out).toContain('fr.pool.ntp.org');
    expect(out).toMatch(/synchronized/i);
  });

  it('etape 5 : un administrateur nominatif se cree et se RELIT', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    propre(await taper(fgt, [
      'config system admin',
      'edit "jdupont"',
      'set accprofile "super_admin"',
      'set password "MotDePasseSolide2026!"',
      'set comments "Administrateur reseau - J. Dupont"',
      'next',
      'end',
    ]));
    const conf = await fgt.executeCommand('show system admin');
    expect(conf).toContain('edit "jdupont"');
    expect(conf).toContain('set accprofile "super_admin"');
    expect(conf).toContain('set comments "Administrateur reseau - J. Dupont"');
    expect(conf).not.toContain('MotDePasseSolide2026!');
  });

  it('etape 5 : le compte cree AUTHENTIFIE vraiment', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await taper(fgt, [
      'config system admin', 'edit "jdupont"',
      'set accprofile "super_admin"', 'set password "MotDePasseSolide2026!"',
      'next', 'end',
    ]);
    expect(fgt.authenticateAdmin('jdupont', 'MotDePasseSolide2026!')).toBe(true);
    expect(fgt.authenticateAdmin('jdupont', 'mauvais')).toBe(false);
  });

  it('etape 6 : `trusthost1` REFUSE toutes les autres adresses', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await taper(fgt, [
      'config system admin', 'edit "jdupont"',
      'set accprofile "super_admin"', 'set password "MotDePasseSolide2026!"',
      'next', 'end',
    ]);
    expect(fgt.adminTrustsSource('jdupont', '192.168.100.50')).toBe(true);

    propre(await taper(fgt, [
      'config system admin', 'edit "jdupont"',
      'set trusthost1 192.168.10.0 255.255.255.0', 'next', 'end',
    ]));
    expect(fgt.adminTrustsSource('jdupont', '192.168.10.25')).toBe(true);
    expect(fgt.adminTrustsSource('jdupont', '192.168.100.50')).toBe(false);
  });

  it('etape 7 : `admintimeout` se pose et se relit', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    propre(await taper(fgt, [
      'config system global', 'set admintimeout 30', 'end',
    ]));
    expect(await fgt.executeCommand('show system global')).toContain('set admintimeout 30');
    expect(fgt.managementIdleTimeoutMs()).toBe(30 * 60_000);
  });

  it('etape 8 : `show system global` ne rend QUE ce qui differe du defaut', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const vierge = await fgt.executeCommand('show system global');
    expect(vierge).not.toContain('set admintimeout');

    await taper(fgt, ['config system global', 'set admintimeout 30', 'end']);
    const apres = await fgt.executeCommand('show system global');
    expect(apres).toContain('set admintimeout 30');
  });

  it('etape 8 : `show full-configuration system global` rend AUSSI les defauts', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const complet = await fgt.executeCommand('show full-configuration system global');
    expect(complet).not.toMatch(/Unknown action/i);
    expect(complet).toContain('set admintimeout');
    expect(complet).toContain('set hostname');
    expect(complet.length).toBeGreaterThan(
      (await fgt.executeCommand('show system global')).length,
    );
  });
});
