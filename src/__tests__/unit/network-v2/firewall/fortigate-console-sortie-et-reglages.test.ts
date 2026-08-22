import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiTerminalSession } from '@/terminal/sessions';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  openFortiConsole, bootFortiConsole, answerPrompt, answerSecret, runCommand, key, tick,
} from './fortiConsoleHarness';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.clear();
});

const seen = (s: FortiTerminalSession) => s.lines.map(l => l.text).join('\n');
const prompted = (s: FortiTerminalSession) =>
  (s.currentInputMode as { promptText?: string }).promptText ?? '';

async function press(s: FortiTerminalSession, k: string): Promise<void> {
  s.handleKey(key(k));
  for (let i = 0; i < 25; i++) await tick();
}

describe('`exit` referme la session que `login` a ouverte', () => {
  it('la commande n est pas refusee', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'exit');
    expect(seen(s)).not.toContain('unknown command');
    expect(seen(s)).not.toContain('Unknown action');
  });

  it('elle rend l invite de connexion', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'exit');
    expect(prompted(s)).toContain('login:');
  });

  it('la porte est refermee : une commande ne s execute plus', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'exit');
    await runCommand(s, 'get system status');
    expect(seen(s)).not.toContain('Version: FortiGate-VM64');
  });

  it('on se reconnecte derriere, avec le mot de passe choisi', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'exit');
    await answerPrompt(s, 'admin');
    await answerSecret(s, 'Fortinet123');
    await runCommand(s, 'get system status');
    expect(seen(s)).toContain('Version: FortiGate-VM64');
  });

  it('`quit` fait la meme chose', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'quit');
    expect(prompted(s)).toContain('login:');
  });
});

describe('`config system console` existe, et ce qu on y regle agit', () => {
  it('la branche est acceptee', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    expect(await fgt.executeCommand('config system console')).not.toContain('Command fail');
  });

  it('`show` reproduit ce qui a ete tape', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await fgt.executeCommand('config system console');
    await fgt.executeCommand('set output standard');
    const vu = await fgt.executeCommand('show');
    await fgt.executeCommand('end');
    expect(vu).toContain('set output standard');
  });

  it('le defaut est `more`, comme sur la vraie machine', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await fgt.executeCommand('config system console');
    const vu = await fgt.executeCommand('get');
    await fgt.executeCommand('end');
    expect(vu).toContain('output              : more');
  });

  it('une valeur inconnue est refusee', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await fgt.executeCommand('config system console');
    const vu = await fgt.executeCommand('set output ecran');
    await fgt.executeCommand('end');
    expect(vu).toContain('Command fail');
  });

  it('`set output more` PAGINE une longue sortie', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'get system interface');
    expect(s.currentInputMode.type).toBe('pager');
  });

  it('`set output standard` supprime la pagination', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    for (const c of ['config system console', 'set output standard', 'end']) {
      await runCommand(s, c);
    }
    await runCommand(s, 'get system interface');
    expect(s.currentInputMode.type).toBe('normal');
  });

  it('`set login disable` ouvre la console sans demander de compte', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const premiere = await openFortiConsole(fgt);
    for (const c of ['config system console', 'set login disable', 'end']) {
      await runCommand(premiere, c);
    }
    const seconde = await bootFortiConsole(fgt);
    expect(prompted(seconde)).not.toContain('login:');
    await runCommand(seconde, 'get system status');
    expect(seen(seconde)).toContain('Version: FortiGate-VM64');
  });
});

describe('`execute reboot` et `execute shutdown` demandent confirmation', () => {
  it('reboot annonce ce qu il va faire, avec les mots de la machine', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute reboot');
    expect(seen(s)).toContain('This operation will reboot the system !');
    expect(prompted(s)).toContain('Do you want to continue? (y/n)');
  });

  it('shutdown a SA phrase, pas celle de reboot', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute shutdown');
    expect(seen(s)).toContain('This operation will shutdown the system !');
    expect(seen(s)).not.toContain('reboot the system');
  });

  it('`n` annule et la machine reste allumee', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute reboot');
    await answerPrompt(s, 'n');
    expect(fgt.getIsPoweredOn()).toBe(true);
    await runCommand(s, 'get system status');
    expect(seen(s)).toContain('Version: FortiGate-VM64');
  });

  it('`y` sur shutdown ETEINT la machine', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute shutdown');
    await answerPrompt(s, 'y');
    expect(fgt.getIsPoweredOn()).toBe(false);
  });

  it('`y` sur reboot repasse par le demarrage et redemande le login', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute reboot');
    await answerPrompt(s, 'y');
    for (let i = 0; i < 60; i++) await tick();
    expect(fgt.getIsPoweredOn()).toBe(true);
    expect(prompted(s)).toContain('login:');
  });

  it('Ctrl+C sur la question annule comme un `n`', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute reboot');
    s.handleKey(key('c', true));
    for (let i = 0; i < 25; i++) await tick();
    expect(fgt.getIsPoweredOn()).toBe(true);
  });

  it('les deux actions figurent dans `execute ?`', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const s = await openFortiConsole(fgt);
    s.setInput('execute ');
    await press(s, '?');
    const vu = seen(s);
    expect(vu).toContain('reboot');
    expect(vu).toContain('shutdown');
  });
});
