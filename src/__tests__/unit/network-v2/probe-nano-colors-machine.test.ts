/*
 * Les couleurs d'interface de nano sur une vraie machine : `/etc/nanorc` et `~/.nanorc` sont lus dans le systeme de fichiers
 * de la machine, avec l'utilisateur de la session, et NO_COLOR vient de l'environnement de la session.  nano-colors-oracle.test.ts
 * et probe-nano-colors.test.ts rejouent le moteur seul contre un vrai nano 7.2 ; ici on mesure le cablage.
 *
 * Mesure avec un moteur qui lit les couleurs sans les evaluer (resolveInterfacePaints qui ignore les combinaisons) : 2 des 5
 * tests tombent (« paints the title bar with the colours of ~/.nanorc », « reads the colours from /etc/nanorc »).  Les trois
 * qui passent avant comme apres : le TEMOIN « sans nanorc la barre de titre est en video inverse », l'erreur « Color "nosuchcolor"
 * not understood » (le rc produisait deja ses erreurs, et le regard reste le defaut) et NO_COLOR, qui ne passe pas par les
 * combinaisons ; ce dernier tombait contre le commit precedent, qui ne le lisait pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { NanoLaunch } from '@/network/devices/linux/editors/editorLaunch';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { paintKey } from '@/network/devices/linux/editors/screen/EditorScreen';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
  await pc.executeCommand('printf "alpha\\nbeta\\n" > /tmp/t.txt');
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

interface EditorMode { type: string; absolutePath: string; nano?: NanoLaunch }
const opened = (): EditorMode => session.inputMode as unknown as EditorMode;

function engineOf(launch: NanoLaunch, environment: Record<string, string> = {}): NanoEngine {
  const fs = new LinuxEditorFsContext(pc, session.shell ?? undefined);
  const withEnvironment = Object.assign(Object.create(fs), { environmentVariable: (name: string) => environment[name] ?? fs.environmentVariable?.(name) ?? null }) as LinuxEditorFsContext;
  const engine = new NanoEngine(withEnvironment, '/tmp/t.txt', 'alpha\nbeta\n', false, false, undefined, false, { settings: launch.settings, rc: launch.rc, menuFlags: launch.menuFlags });
  engine.resize(24, 80);
  return engine;
}

const titlePaint = (engine: NanoEngine): string | null => {
  const span = engine.screen.rows[0].spans[0];
  return span?.paint === undefined ? span?.style ?? null : paintKey(span.paint);
};

describe('nano interface colours on a machine, one measured behaviour per test', () => {
  it('WITNESS: without a nanorc the title bar is the plain reverse video', async () => {
    await type('nano /tmp/t.txt');
    expect(titlePaint(engineOf(opened().nano!))).toBe('reverse');
  });

  it('paints the title bar with the colours of ~/.nanorc', async () => {
    await pc.executeCommand('printf "set titlecolor red,green\\n" > ~/.nanorc');
    await type('nano /tmp/t.txt');
    expect(titlePaint(engineOf(opened().nano!))).toBe('1/2/');
  });

  it('reads the colours from /etc/nanorc when the user has no file of their own', async () => {
    await pc.executeCommand(`sudo bash -c 'printf "set titlecolor yellow,blue\\n" > /etc/nanorc'`);
    await type('nano /tmp/t.txt');
    expect(titlePaint(engineOf(opened().nano!))).toBe('3/4/');
  });

  it('reports a colour nano does not know like nano does, and keeps the default look', async () => {
    await pc.executeCommand('printf "set titlecolor nosuchcolor\\n" > ~/.nanorc');
    await type('nano /tmp/t.txt');
    const launch = opened().nano!;
    expect(launch.rc!.errors).toEqual(['Error in /home/user/.nanorc on line 1: Color "nosuchcolor" not understood']);
    expect(titlePaint(engineOf(launch))).toBe('reverse');
  });

  it('honours NO_COLOR of the session environment when no colour is configured', async () => {
    await type('nano /tmp/t.txt');
    const alertLook = (environment: Record<string, string>): string[] => {
      const engine = engineOf(opened().nano!, environment);
      engine.applyKey({ key: '_', ctrl: true });
      engine.applyKey({ key: 'x' });
      engine.applyKey({ key: 'Enter' });
      return engine.screen.rows[engine.screen.rows.length - 3].spans.map((span) => span.style);
    };
    expect(alertLook({})).toEqual(['alert']);
    expect(alertLook({ NO_COLOR: '1' })).toEqual(['reverse']);
  });
});
