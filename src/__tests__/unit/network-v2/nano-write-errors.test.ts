/**
 * Nano — échecs d'écriture (permission refusée, disque plein, etc.).
 *
 * NanoEngine ignorait jusqu'ici le booléen de retour de
 * `EditorFsContext.writeFile`, affichant toujours "[ Wrote N lines ]" et
 * quittant même quand rien n'avait été écrit — perte de données
 * silencieuse. Ce fichier fixe le contrat attendu : un échec d'écriture
 * affiche un message d'erreur, laisse le buffer "modified", et — au
 * ^X→Y — n'exécute PAS la sortie (l'utilisateur reste dans le buffer
 * pour retenter, exactement comme le VimEngine existant sur E212).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrl(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { ctrl: true }));
}

/** Force the next writeFile call(s) on `fs` to fail, like a real permission error. */
function makeWriteFail(fs: InMemoryEditorFsContext, blockedPath: string): void {
  const original = fs.writeFile.bind(fs);
  fs.writeFile = (path: string, content: string) => (path === blockedPath ? false : original(path, content));
}

describe('Scénario — ^O (Write Out) échoue silencieusement en écriture', () => {
  it('affiche un message d\'erreur au lieu de "[ Wrote N lines ]", et le buffer reste modifié', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/shadow': 'root:x:...\n' });
    makeWriteFail(fs, '/etc/shadow');
    const nano = new NanoEngine(fs, '/etc/shadow', 'root:x:...\n', false);
    typeText(nano, 'z'); // make a change so modified=true beforehand
    ctrl(nano, 'o');
    expect(nano.mode).toBe('save-prompt');
    press(nano, 'Enter');
    expect(nano.mode).toBe('edit');
    expect(nano.statusMessage).toBe('[ Error writing /etc/shadow ]');
    expect(nano.modified).toBe(true);
  });

  it('un ^O réussi ensuite (autre chemin) écrit normalement et efface "modified"', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    typeText(nano, 'z');
    ctrl(nano, 'o');
    press(nano, 'Enter');
    expect(nano.statusMessage).toBe('[ Wrote 1 line ]');
    expect(nano.modified).toBe(false);
  });
});

describe('Scénario — ^X puis Y (exit-save) échoue en écriture : ne PAS quitter', () => {
  it('l\'échec affiche une erreur, le buffer reste ouvert (non "exited"), et reste modifié', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/sudoers': 'root ALL=(ALL) ALL\n' });
    makeWriteFail(fs, '/etc/sudoers');
    const nano = new NanoEngine(fs, '/etc/sudoers', 'root ALL=(ALL) ALL\n', false);
    typeText(nano, 'z');
    ctrl(nano, 'x');
    expect(nano.mode).toBe('exit-save-prompt');
    press(nano, 'y');
    expect(nano.mode).toBe('save-prompt'); // real nano always chains to "File Name to Write:"
    press(nano, 'Enter');
    expect(nano.exited).toBe(false);
    expect(nano.mode).toBe('edit');
    expect(nano.statusMessage).toBe('[ Error writing /etc/sudoers ]');
    expect(nano.modified).toBe(true);
  });

  it('un ^X→Y réussi quitte normalement avec savedOnExit=true', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/y.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/y.txt', 'a\n', false);
    typeText(nano, 'z');
    ctrl(nano, 'x');
    press(nano, 'y');
    press(nano, 'Enter');
    expect(nano.exited).toBe(true);
    expect(nano.savedOnExit).toBe(true);
  });
});

describe('Scénario — permission refusée réelle (LinuxPC + LinuxEditorFsContext, sans double)', () => {
  let pc: LinuxPC;
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
  });

  it('un utilisateur non privilégié ne peut pas créer /etc/fstab (parent /etc root:root 0755) : ^O échoue avec un message d\'erreur', () => {
    const fsCtx = new LinuxEditorFsContext(pc);
    expect(fsCtx.readFile('/etc/fstab')).toBeNull();

    const nano = new NanoEngine(fsCtx, '/etc/fstab', '', true, false);
    typeText(nano, 'tmpfs /mnt/ramtest tmpfs defaults 0 0');
    ctrl(nano, 'o');
    press(nano, 'Enter');

    expect(nano.statusMessage).toBe('[ Error writing /etc/fstab ]');
    expect(nano.modified).toBe(true);
    expect(fsCtx.readFile('/etc/fstab')).toBeNull(); // still absent — the write never landed
  });

  it('le même utilisateur non privilégié : ^X→Y échoue et ne quitte pas nano', () => {
    const fsCtx = new LinuxEditorFsContext(pc);
    const nano = new NanoEngine(fsCtx, '/etc/fstab', '', true, false);
    typeText(nano, 'tmpfs /mnt/ramtest tmpfs defaults 0 0');
    ctrl(nano, 'x');
    press(nano, 'y');
    press(nano, 'Enter');

    expect(nano.exited).toBe(false);
    expect(nano.statusMessage).toBe('[ Error writing /etc/fstab ]');
  });

  it('en root (session privilégiée), la même écriture réussit', () => {
    const rootSession = pc.openShellSession({ user: 'root' });
    const fsCtx = new LinuxEditorFsContext(pc, rootSession);
    const nano = new NanoEngine(fsCtx, '/etc/fstab', '', true, false);
    typeText(nano, 'tmpfs /mnt/ramtest tmpfs defaults 0 0');
    ctrl(nano, 'o');
    press(nano, 'Enter');

    expect(nano.statusMessage).toBe('[ Wrote 1 line ]');
    expect(nano.modified).toBe(false);
    expect(fsCtx.readFile('/etc/fstab')).toBe('tmpfs /mnt/ramtest tmpfs defaults 0 0\n');
  });
});
