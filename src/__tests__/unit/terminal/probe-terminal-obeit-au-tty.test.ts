/**
 * Ce que `stty` regle et qu'un mecanisme du simulateur LIT (regle 6) : la touche d'interruption du terminal
 * (`intr`, soumise a `isig`) et l'ecriture a l'ecran de ce que `read` recoit (`echo`).  Les trois transcripts
 * viennent de bash 5.2 sous tmux : apres `stty intr ^X`, `^X` sur `abc` laisse `abc^X` puis une invite neuve et
 * `^C` ne fait plus rien ; apres `stty -isig` ni l'un ni l'autre n'interrompt ; apres `stty -echo`, `read x`
 * ne montre pas ce qu'on tape (et `read -s` ne le montre jamais).
 *
 * Mesure avec `git stash push -- src/network src/terminal src/shell` : 4 cas sur 6 tombent avant (le terminal ne
 * regardait que la touche Ctrl+C et `read` ne regardait pas le tty).  Deux passent des deux cotes : TEMOIN,
 * Ctrl+C sur un tty neuf echoe `^C` (le lab interrompt bien), et TEMOIN, `read -s` demande un mot de passe
 * quel que soit l'etat de l'echo.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
function ctrl(k: string): KeyEvent {
  return { key: k, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 10));

describe('the Linux terminal obeys the tty it sits on', () => {
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetCounters();
    resetDeviceCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    const manager = new TerminalManager(bus);
    const pc = new LinuxPC('PC1', 0, 0);
    pc.setEventBus(bus);
    const sid = manager.openTerminal(pc)!;
    session = manager.getSession(sid) as LinuxTerminalSession;
    await session.init?.();
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  function screen(): string {
    return session.lines.map((l) => (typeof l === 'string' ? l : (l as { text?: string }).text ?? '')).join('\n');
  }

  it('TEMOIN : on a fresh tty Ctrl+C interrupts the typed line and echoes ^C', () => {
    session.setInput('abc');
    session.handleKey(ctrl('c'));
    expect(screen()).toContain('abc^C');
    expect(session.input).toBe('');
  });

  it('after stty intr ^X, ^X interrupts and echoes ^X while ^C does nothing', async () => {
    await type('stty intr ^X');
    session.setInput('abc');
    session.handleKey(ctrl('c'));
    expect(screen()).not.toContain('abc^C');
    expect(session.input).toBe('abc');
    session.handleKey(ctrl('x'));
    expect(screen()).toContain('abc^X');
    expect(session.input).toBe('');
  });

  it('after stty -isig neither ^C nor the interrupt character interrupts', async () => {
    await type('stty -isig');
    session.setInput('abc');
    session.handleKey(ctrl('c'));
    expect(session.input).toBe('abc');
    await type('stty isig');
    session.setInput('abc');
    session.handleKey(ctrl('c'));
    expect(session.input).toBe('');
  });

  it('read shows what is typed while the tty echoes, and hides it after stty -echo', async () => {
    void type('read visible');
    await flush();
    expect(session.currentInputMode.type).toBe('interactive-text');
    session.setInputBuf('a');
    session.handleKey(key('Enter'));
    await flush();
    await type('stty -echo');
    void type('read hidden');
    await flush();
    expect(session.currentInputMode.type).toBe('password');
  });

  it('the answer typed into a silent read is still the value of the variable', async () => {
    await type('stty -echo');
    void type('read secret');
    await flush();
    session.setPasswordBuf('hunter2');
    session.handleKey(key('Enter'));
    await flush();
    await type('echo got=$secret');
    expect(screen()).toContain('got=hunter2');
  });

  it('TEMOIN : read -s asks for a password whatever the state of echo', async () => {
    void type('read -s quiet');
    await flush();
    expect(session.currentInputMode.type).toBe('password');
  });
});
