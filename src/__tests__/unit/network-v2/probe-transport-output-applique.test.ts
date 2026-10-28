/*
 * Sonde — `transport output` est APPLIQUE a la ligne qui lance une connexion sortante, au lieu d'etre seulement stocke et rendu.
 *
 * Mesure AVANT : `transport output none` sous `line console 0` s'ecrivait dans la running-config et `telnet 10.0.0.2` atteignait quand
 * meme R2. Le libelle `% Telnet connections not permitted from this terminal` est celui de la machine reelle tel que je le connais ;
 * la documentation Cisco n'etait pas joignable depuis cet environnement pour le confirmer (TODO.md).
 *
 * TROIS cas sur cinq tombent avant (refus telnet, refus ssh, session vty) (le refus telnet et le refus ssh). Les deux autres sont NOMMES : le temoin (sans reglage, R2 est
 * atteint) et `transport output telnet` qui laisse passer telnet (non-regression : un reglage qui n'exclut pas le protocole ne refuse rien).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, ctrl = false): KeyEvent {
  return { key: k, ctrlKey: ctrl, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 60): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

interface Typing {
  setInput(text: string): void;
  setInputBuf(text: string): void;
  handleKey(e: KeyEvent): boolean;
  lines: ReadonlyArray<{ text: string }>;
  getPrompt(): string;
}

async function type(term: Typing, text: string): Promise<void> {
  term.setInput(text);
  term.setInputBuf(text);
  term.handleKey(key('Enter'));
  await flush();
}

async function press(term: Typing, k: string, ctrl = false): Promise<void> {
  term.handleKey(key(k, ctrl));
  await flush();
}

const screen = (term: Typing): string => term.lines.map((l) => l.text).join('\n');

async function lan(): Promise<{ r1: CiscoRouter; r2: CiscoRouter }> {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  new Cable('a').connect(r1.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(r2.getPorts()[0], sw.getPorts()[1]);
  for (const [router, ip] of [[r1, '10.0.0.1'], [r2, '10.0.0.2']] as const) {
    for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end']) {
      await router.executeCommand(cmd);
    }
  }
  return { r1, r2 };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('transport output applique aux connexions sortantes', () => {
  it('temoin : sans reglage, telnet atteint R2', async () => {
    const { r1 } = await lan();
    const term = new CiscoTerminalSession('t', r1);
    await term.init();
    await type(term, 'telnet 10.0.0.2');
    expect(term.getPrompt()).toContain('R2');
  });

  it('transport output none refuse telnet', async () => {
    const { r1 } = await lan();
    for (const c of ['configure terminal', 'line console 0', 'transport output none', 'end']) await r1.executeCommand(c);
    const term = new CiscoTerminalSession('t', r1);
    await term.init();
    await type(term, 'telnet 10.0.0.2');
    expect(screen(term)).toContain('% Telnet connections not permitted from this terminal');
    expect(term.getPrompt()).toContain('R1');
  });

  it('transport output telnet laisse passer telnet', async () => {
    const { r1 } = await lan();
    for (const c of ['configure terminal', 'line console 0', 'transport output telnet', 'end']) await r1.executeCommand(c);
    const term = new CiscoTerminalSession('t', r1);
    await term.init();
    await type(term, 'telnet 10.0.0.2');
    expect(term.getPrompt()).toContain('R2');
  });

  it('transport output telnet refuse ssh', async () => {
    const { r1 } = await lan();
    for (const c of ['configure terminal', 'line console 0', 'transport output telnet', 'end']) await r1.executeCommand(c);
    const term = new CiscoTerminalSession('t', r1);
    await term.init();
    await type(term, 'ssh -l admin 10.0.0.2');
    expect(screen(term)).toContain('% SSH connections not permitted from this terminal');
  });

  it('une session vty est refusee selon l intervalle de sa ligne', async () => {
    const { r1 } = await lan();
    for (const c of ['configure terminal', 'line vty 0 4', 'transport output none', 'end']) await r1.executeCommand(c);
    const term = new CiscoTerminalSession('t', r1);
    term.attachToVtyLine();
    await term.init();
    await type(term, 'telnet 10.0.0.2');
    expect(screen(term)).toContain('% Telnet connections not permitted from this terminal');
  });
});
