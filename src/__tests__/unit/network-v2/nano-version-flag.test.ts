/**
 * `nano --version` / `nano -V` doit imprimer la bannière de version et
 * revenir au prompt — pas ouvrir l'éditeur. openEditor() ne reconnaissait
 * aucun flag : tout argument commençant par `-` était simplement ignoré
 * lors de la recherche du nom de fichier, donc `nano --version` ouvrait
 * un buffer vide sans nom comme `nano` seul. Même bug pour `--help`/`-h`.
 * Le fallback batch/SSH (LinuxCommandExecutor, sans TTY) a le même trou.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

describe('Scénario — `nano --version` / `-V` imprime la bannière au lieu d\'ouvrir l\'éditeur', () => {
  it('`nano --version` ne bascule PAS en mode éditeur', async () => {
    await type('nano --version');
    expect(session.inputMode.type).toBe('normal');
  });

  it('`nano --version` affiche "GNU nano, version 6.2"', async () => {
    await type('nano --version');
    const last = session.lines.slice(-5).map((l) => l.text).join('\n');
    expect(last).toContain('GNU nano, version 6.2');
  });

  it('`nano -V` (forme courte) a le même effet', async () => {
    await type('nano -V');
    expect(session.inputMode.type).toBe('normal');
    const last = session.lines.slice(-5).map((l) => l.text).join('\n');
    expect(last).toContain('GNU nano, version 6.2');
  });

  it('`nano --help` / `-h` n\'ouvrent pas non plus l\'éditeur (même trou, même correctif)', async () => {
    await type('nano --help');
    expect(session.inputMode.type).toBe('normal');
    let last = session.lines.slice(-10).map((l) => l.text).join('\n');
    expect(last).toContain('Usage:  nano');

    await type('nano -h');
    expect(session.inputMode.type).toBe('normal');
    last = session.lines.slice(-10).map((l) => l.text).join('\n');
    expect(last).toContain('Usage:  nano');
  });

  it('un vrai `nano fichier` ouvre toujours bien l\'éditeur (pas de régression)', async () => {
    await type('nano /tmp/x.txt');
    expect(session.inputMode.type).toBe('editor');
  });
});

describe('Scénario — fallback batch/SSH (sans TTY) : `nano --version` imprime aussi la bannière', () => {
  it('exécute `nano --version` via le PC (LinuxCommandExecutor) sans créer de fichier ni planter', async () => {
    const output = await pc.executeCommand('nano --version');
    expect(output).toContain('GNU nano, version 6.2');
  });
});
