/**
 * `CTRL-V` fait du `?` suivant un caractere ordinaire.
 *
 * La page « CLI basics » ecrit : « If you enter ? without first using
 * CTRL-V, the question mark has a different meaning in the CLI; it will
 * show available command options in that section. » C'etait la derniere
 * fonction de la page a manquer, et elle etait inscrite au `TODO.md`
 * comme impossible dans un navigateur — ce qui etait FAUX, et la mesure
 * l'a montre : la vue ne bloque le collage que si la session CONSOMME la
 * touche (`if (consumed) e.preventDefault()`). Une touche de PREFIXE n'a
 * pas besoin de la consommer : elle arme le prochain `?` et laisse le
 * collage se faire.
 *
 * 1. Sans prefixe, `?` ouvre l'aide (TEMOIN — c'etait deja vrai).
 * 2. Apres Ctrl+V, le `?` n'ouvre PAS l'aide.
 * 3. Ctrl+V n'est pas consomme, donc le collage du navigateur survit.
 * 4. L'armement ne vaut que pour la touche suivante.
 *
 * Discrimine par `git stash push -- src/terminal/` : UN seul cas tombe,
 * le 2, et c'est exact — le defaut etait unique. Les trois autres
 * passent des DEUX cotes et sont nommes ici plutot que laisses a
 * decouvrir : le 1 est le TEMOIN de l'aide ; le 3 gardait deja le
 * collage, puisque rien ne traitait Ctrl+V ; et le 4 ne prouve rien
 * avant correctif, un armement qui n'existe pas ne pouvant pas durer
 * trop longtemps — il ne vaut que comme garde de la regle une fois
 * qu'elle existe.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { openFortiConsole } from './fortiConsoleHarness';
import type { FortiTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.clear();
});

const key = (k: string, ctrl = false): KeyEvent =>
  ({ key: k, ctrlKey: ctrl, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

async function console_(): Promise<FortiTerminalSession> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  for (const c of [
    'config system admin', 'edit "admin"', 'set password "Fortinet123"', 'next', 'end',
  ]) await fgt.executeCommand(c);
  return openFortiConsole(fgt, 'Fortinet123');
}

const vu = (s: FortiTerminalSession) => s.lines.map(l => l.text).join('\n');

describe('CTRL-V rend le `?` litteral', () => {
  it('TEMOIN : sans prefixe, `?` ouvre l\'aide', async () => {
    const s = await console_();
    const avant = vu(s).length;

    s.setInput('config ');
    expect(s.handleKey(key('?'))).toBe(true);

    expect(vu(s).length).toBeGreaterThan(avant);
  });

  it('apres Ctrl+V, le `?` n\'ouvre pas l\'aide', async () => {
    const s = await console_();

    s.setInput('config ');
    s.handleKey(key('v', true));
    const avant = vu(s).length;

    expect(s.handleKey(key('?'))).toBe(false);
    expect(vu(s).length).toBe(avant);
  });

  it('Ctrl+V n\'est pas consomme, donc le collage survit', async () => {
    const s = await console_();

    expect(s.handleKey(key('v', true))).toBe(false);
  });

  it('l\'armement ne vaut que pour la touche suivante', async () => {
    const s = await console_();

    s.setInput('config ');
    s.handleKey(key('v', true));
    s.handleKey(key('x'));
    const avant = vu(s).length;

    expect(s.handleKey(key('?'))).toBe(true);
    expect(vu(s).length).toBeGreaterThan(avant);
  });
});
