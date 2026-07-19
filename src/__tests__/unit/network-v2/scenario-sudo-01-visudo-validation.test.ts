/**
 * Scénario 1 — Validation syntaxique visudo et comportement en cas d'erreur.
 *
 * visudo doit refuser d'installer un contenu syntaxiquement invalide,
 * identifier la ligne fautive, et laisser le fichier d'origine identique
 * (checksum MD5 inchangé) après toute tentative de sauvegarde invalide.
 * `visudo -c` / `visudo -c -f` doivent être déterministes : exit 0 si
 * valide, non nul sinon, sans jamais modifier le fichier vérifié.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

let srv: LinuxServer;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  srv = new LinuxServer('linux-server', 'SRV1', 0, 0);
  srv.powerOn();
  session = new LinuxTerminalSession('term-1', srv);
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

async function md5(path: string): Promise<string> {
  const out = await srv.executeCommand(`md5sum ${path}`);
  return out.split(/\s+/)[0];
}

async function attemptInvalidSave(invalidContent: string): Promise<void> {
  await type('visudo');
  const mode = session.inputMode as { absolutePath: string };
  session.editorSave(invalidContent, mode.absolutePath);
  session.editorExit(true);
  await flush();
  // Real visudo never silently discards a rejected save — it prints a
  // "What now?" recovery prompt and awaits e/x/Q on the next line before
  // the terminal is usable again. Answer (x)exit so callers get a normal,
  // reusable prompt back.
  await type('x');
}

describe('Scénario 1 — visudo : validation syntaxique et intégrité', () => {
  it('checksum MD5 de /etc/sudoers identique après une tentative de sauvegarde avec parenthèses non fermées (Runas_Spec)', async () => {
    const before = await md5('/etc/sudoers');
    await attemptInvalidSave('root ALL=(ALL:ALL) ALL\nadmin1 ALL=(ALL:ALL ALL\n');
    const after = await md5('/etc/sudoers');
    expect(after).toBe(before);
  });

  it('checksum MD5 identique après une tentative de sauvegarde avec champ manquant (pas de "=")', async () => {
    const before = await md5('/etc/sudoers');
    await attemptInvalidSave('root ALL=(ALL:ALL) ALL\nadmin1 ALL ALL\n');
    const after = await md5('/etc/sudoers');
    expect(after).toBe(before);
  });

  it('checksum MD5 identique après une tentative avec liste de privilèges vide', async () => {
    const before = await md5('/etc/sudoers');
    await attemptInvalidSave('root ALL=(ALL:ALL) ALL\nadmin1 ALL=\n');
    const after = await md5('/etc/sudoers');
    expect(after).toBe(before);
  });

  it('identifie la ligne fautive exacte (numéro de ligne) dans le message d\'erreur', async () => {
    await attemptInvalidSave('root ALL=(ALL:ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\nadmin1 ALL ALL\n');
    const errLine = session.lines.find((l) => l.text.includes('syntax error near line'));
    expect(errLine).toBeDefined();
    expect(errLine!.text).toContain('near line 3');
  });

  it('le fichier reste inchangé (contenu, pas seulement checksum) après une sauvegarde invalide', async () => {
    const before = await srv.executeCommand('cat /etc/sudoers');
    await attemptInvalidSave('totally not sudoers syntax === ???\n');
    const after = await srv.executeCommand('cat /etc/sudoers');
    expect(after).toBe(before);
  });

  it('visudo -c sur un /etc/sudoers valide : exit 0, "parsed OK", fichier non modifié', async () => {
    const before = await md5('/etc/sudoers');
    const out = await srv.executeCommand('visudo -c; echo "EXIT:$?"');
    expect(out).toContain('parsed OK');
    expect(out).toContain('EXIT:0');
    const after = await md5('/etc/sudoers');
    expect(after).toBe(before);
  });

  it('visudo -c -f sur un fichier invalide : exit non nul, ligne fautive rapportée, fichier non modifié', async () => {
    await srv.executeCommand('mkdir -p /etc/sudoers.d');
    await srv.executeCommand("echo 'admin1 ALL ALL' > /etc/sudoers.d/broken");
    const before = await md5('/etc/sudoers.d/broken');
    const out = await srv.executeCommand('visudo -c -f /etc/sudoers.d/broken; echo "EXIT:$?"');
    expect(out).toMatch(/syntax error near line 1/);
    expect(out).not.toContain('EXIT:0');
    const after = await md5('/etc/sudoers.d/broken');
    expect(after).toBe(before);
  });

  it('visudo -c -f sur un fichier valide : exit 0, "parsed OK"', async () => {
    await srv.executeCommand('mkdir -p /etc/sudoers.d');
    await srv.executeCommand("echo 'admin1 ALL=(ALL:ALL) ALL' > /etc/sudoers.d/good");
    const out = await srv.executeCommand('visudo -c -f /etc/sudoers.d/good; echo "EXIT:$?"');
    expect(out).toContain('parsed OK');
    expect(out).toContain('EXIT:0');
  });

  it('deux erreurs distinctes et indépendantes produisent chacune un checksum inchangé', async () => {
    const before = await md5('/etc/sudoers');
    await attemptInvalidSave('root ALL=(ALL:ALL) ALL\nUser_Alias = admin1\n');
    expect(await md5('/etc/sudoers')).toBe(before);
    await attemptInvalidSave('root ALL=(ALL:ALL) ALL\nadmin1 ALL=(ALL:ALL\n');
    expect(await md5('/etc/sudoers')).toBe(before);
  });

  it('après un rejet, visudo reste utilisable et une sauvegarde valide ultérieure fonctionne normalement (pas de verrou bloquant)', async () => {
    await attemptInvalidSave('garbage\n');
    await type('visudo');
    const mode = session.inputMode as { absolutePath: string };
    session.editorSave('root ALL=(ALL:ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\nadmin1 ALL=(ALL:ALL) ALL\n', mode.absolutePath);
    session.editorExit(true);
    await flush();
    const sudoers = await srv.executeCommand('cat /etc/sudoers');
    expect(sudoers).toContain('admin1 ALL=(ALL:ALL) ALL');
  });

  it('abandon de l\'édition (pas de sauvegarde) laisse le checksum inchangé', async () => {
    const before = await md5('/etc/sudoers');
    await type('visudo');
    session.editorExit(false);
    await flush();
    expect(await md5('/etc/sudoers')).toBe(before);
  });
});
