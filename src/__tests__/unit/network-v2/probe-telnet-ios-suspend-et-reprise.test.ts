/*
 * Sonde — une session telnet sortante d'un routeur Cisco se SUSPEND (Ctrl-Maj-6 puis x) et se REPREND, au lieu d'occuper le terminal.
 *
 * Mesure AVANT, sur R1 qui tape `telnet 10.0.0.2` vers R2 : la frappe Ctrl-Maj-6 n'avait aucun effet, la seule sortie de la session
 * etait `exit` cote distant ; `show sessions` restait vide (la session interactive n'etait inscrite nulle part, seule la session
 * scriptee l'etait) ; et la fin cote distant s'ecrivait « Connection closed by foreign host. », le mot du client BSD, sous une invite IOS.
 * Les libelles `[Resuming connection N to H ... ]`, `Closing connection to H [confirm]` et l'en-tete de `show sessions` sont ceux que le
 * shell Cisco rendait deja ; `[Connection to H closed by foreign host]` est le mot du client IOS.
 *
 * CINQ cas sur sept tombent avant. Les deux autres sont NOMMES : le temoin (R2 est atteint et son invite s'affiche) et `disconnect ferme
 * la session suspendue`, qui passe aussi avant sans que je sache dire par quel chemin (la suspension n'existait pas : la ligne atteignait
 * R2) ; il ne prouve donc pas le mecanisme.
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

describe('telnet sortant IOS : suspension et reprise', () => {
  it('temoin : R2 est atteint et son invite s\'affiche', async () => {
    const { r1 } = await lan();
    const term = new CiscoTerminalSession('t', r1);
    await type(term, 'telnet 10.0.0.2');
    expect(term.getPrompt()).toContain('R2');
  });

  it('Ctrl-Maj-6 puis x rend l\'invite locale', async () => {
    const { r1 } = await lan();
    const term = new CiscoTerminalSession('t', r1);
    await type(term, 'telnet 10.0.0.2');
    await press(term, '^', true);
    await press(term, 'x');
    expect(term.getPrompt()).toContain('R1');
  });

  it('show sessions liste la session suspendue', async () => {
    const { r1 } = await lan();
    const term = new CiscoTerminalSession('t', r1);
    await type(term, 'telnet 10.0.0.2');
    await press(term, '^', true);
    await press(term, 'x');
    await type(term, 'show sessions');
    expect(screen(term)).toContain('Conn Host                Address             Byte  Idle Conn Name');
    expect(screen(term)).toMatch(/\*?\s*1 10\.0\.0\.2/);
  });

  it('resume reprend la session et rend l\'invite distante', async () => {
    const { r1 } = await lan();
    const term = new CiscoTerminalSession('t', r1);
    await type(term, 'telnet 10.0.0.2');
    await press(term, '^', true);
    await press(term, 'x');
    await type(term, 'resume 1');
    expect(screen(term)).toContain('[Resuming connection 1 to 10.0.0.2 ... ]');
    expect(term.getPrompt()).toContain('R2');
  });

  it('Entree sur une ligne vide reprend la derniere session', async () => {
    const { r1 } = await lan();
    const term = new CiscoTerminalSession('t', r1);
    await type(term, 'telnet 10.0.0.2');
    await press(term, '^', true);
    await press(term, 'x');
    await type(term, '');
    expect(term.getPrompt()).toContain('R2');
  });

  it('disconnect ferme la session suspendue', async () => {
    const { r1 } = await lan();
    const term = new CiscoTerminalSession('t', r1);
    await type(term, 'telnet 10.0.0.2');
    await press(term, '^', true);
    await press(term, 'x');
    await type(term, 'disconnect 1');
    expect(screen(term)).toContain('Closing connection to 10.0.0.2 [confirm]');
    await type(term, 'show sessions');
    expect(screen(term)).toContain('% No connections open');
  });

  it('la fin cote distant s\'ecrit avec les mots du client IOS', async () => {
    const { r1 } = await lan();
    const term = new CiscoTerminalSession('t', r1);
    await type(term, 'telnet 10.0.0.2');
    await type(term, 'exit');
    expect(screen(term)).toContain('[Connection to 10.0.0.2 closed by foreign host]');
    expect(screen(term)).not.toContain('Connection closed by foreign host.');
  });
});
