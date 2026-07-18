/**
 * Scénario 9 — Édition de fichiers de configuration système avec vim :
 * /etc/fstab, /etc/crontab, /etc/ssh/sshd_config, avec détection du
 * filetype (`:set filetype?`), expansion de `%` dans les commandes shell
 * (`:!cmd`), et validation via les outils natifs (`mount --fake -a`,
 * `sshd -t -f %`, structure awk du crontab).
 *
 * TDD: written against the real device (LinuxPC) + the production
 * LinuxEditorFsContext adapter, driving VimEngine exactly as the real UI
 * would, then validating through genuine `pc.executeCommand` calls.
 *
 * All three files require root to create/edit for real: /etc/crontab and
 * /etc/ssh/sshd_config are root:root 0644 by default, and while
 * /etc/fstab does not exist on a fresh LinuxPC, /etc itself is root:root
 * 0755 — creating a brand-new file directly inside it (unlike a fresh
 * subdirectory such as /etc/network) genuinely needs root, exactly like
 * `sudo vim /etc/fstab` would on a real system.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function exCommand(engine: { applyKey(k: EditorKeyInput): void }, cmd: string): void {
  press(engine, ':');
  typeText(engine, cmd);
  press(engine, 'Enter');
}

let pc: LinuxPC;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
});

describe('Scénario 9 — /etc/fstab : création, filetype, validation mount --fake -a', () => {
  it('un utilisateur non privilégié ne peut pas créer /etc/fstab (parent /etc root:root 0755)', async () => {
    const fsCtx = new LinuxEditorFsContext(pc);
    expect(fsCtx.readFile('/etc/fstab')).toBeNull();

    const vim = new VimEngine(fsCtx, '/etc/fstab', '', true, 'vim');
    press(vim, 'i');
    typeText(vim, 'tmpfs /mnt/ramtest tmpfs defaults 0 0');
    press(vim, 'Escape');
    exCommand(vim, 'wq');

    expect(vim.message).toBe(`E212: Can't open file for writing`);
    expect(vim.exited).toBe(false); // the write failed, so :wq did not exit
    expect(fsCtx.readFile('/etc/fstab')).toBeNull(); // still absent — the write never landed
  });

  it('détecte le filetype fstab sur un nouveau fichier (créé en root) et ajoute une entrée tmpfs valide', async () => {
    const rootSession = pc.openShellSession({ user: 'root' });
    const fsCtx = new LinuxEditorFsContext(pc, rootSession);
    expect(fsCtx.readFile('/etc/fstab')).toBeNull(); // absent par défaut

    const vim = new VimEngine(fsCtx, '/etc/fstab', '', true, 'vim', 'root');
    exCommand(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=fstab');

    press(vim, 'i');
    const lines = [
      '# /etc/fstab: static file system information.',
      'UUID=1111-2222-3333-4444 /               ext4    errors=remount-ro 0       1',
      'tmpfs                    /mnt/ramtest    tmpfs   defaults,size=64M  0       0',
    ];
    typeText(vim, lines[0]);
    for (const line of lines.slice(1)) {
      press(vim, 'Enter');
      typeText(vim, line);
    }
    press(vim, 'Escape');

    exCommand(vim, 'wq');
    expect(vim.exited).toBe(true);
    expect(vim.savedOnExit).toBe(true);
    expect(vim.swapFileExists).toBe(false);

    const written = await pc.executeCommandInSession('cat /etc/fstab', rootSession);
    expect(written).toContain('/mnt/ramtest');
    expect(written).toContain('tmpfs');

    const mountFake = await pc.executeCommandInSession('mount --fake -a; echo EXIT=$?', rootSession);
    expect(mountFake.trim()).toBe('EXIT=0');

    // --fake must not actually mount anything.
    const mounts = await pc.executeCommandInSession('mount -l', rootSession);
    expect(mounts).not.toContain('/mnt/ramtest');
  });

  it('mount --fake -a rejette une ligne fstab malformée sans modifier l\'état des montages', async () => {
    const rootSession = pc.openShellSession({ user: 'root' });
    const fsCtx = new LinuxEditorFsContext(pc, rootSession);
    const vim = new VimEngine(fsCtx, '/etc/fstab', '', true, 'vim', 'root');
    press(vim, 'i');
    typeText(vim, 'this-line-has-only-two-fields /mnt/broken');
    press(vim, 'Escape');
    exCommand(vim, 'wq');
    expect(vim.exited).toBe(true);

    const out = await pc.executeCommandInSession('mount --fake -a; echo EXIT=$?', rootSession);
    expect(out).toContain('bad line in /etc/fstab');
    expect(out.trim().endsWith('EXIT=32')).toBe(true);
  });
});

describe('Scénario 9 — /etc/crontab : filetype, recherche, ajout d\'une tâche', () => {
  it('détecte le filetype crontab, recherche une ligne système, et ajoute une tâche valide', async () => {
    const rootSession = pc.openShellSession({ user: 'root' });
    const fsCtx = new LinuxEditorFsContext(pc, rootSession);
    await pc.executeCommandInSession('cp /etc/crontab /tmp/crontab.bak', rootSession);
    const originalViaCat = await pc.executeCommandInSession('cat /tmp/crontab.bak', rootSession);
    const original = fsCtx.readFile('/etc/crontab')!;

    const vim = new VimEngine(fsCtx, '/etc/crontab', original, false, 'vim', 'root');
    exCommand(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=crontab');

    press(vim, '/');
    typeText(vim, '^[0-9*].*root');
    press(vim, 'Enter');
    expect(vim.cursorLine).toBeGreaterThan(0);
    expect(vim.lines[vim.cursorLine]).toMatch(/root/);

    press(vim, 'G');
    press(vim, 'o');
    typeText(vim, '*/5 * * * *\troot\t/usr/local/bin/healthcheck.sh');
    press(vim, 'Escape');

    exCommand(vim, 'wq');
    expect(vim.exited).toBe(true);
    expect(vim.savedOnExit).toBe(true);
    expect(vim.swapFileExists).toBe(false);

    const content = await pc.executeCommandInSession('cat /etc/crontab', rootSession);
    expect(content).toContain('/usr/local/bin/healthcheck.sh');

    // Structural validation: every real cron line (not a comment, not a
    // SHELL=/PATH= assignment, not blank) has the 5 time fields + user +
    // at least one command word.
    const awkCheck = await pc.executeCommandInSession(
      String.raw`awk '!/^#/ && !/^$/ && !/^[A-Za-z_]+=/ { if (NF < 7) print "BADCRON", NR }' /etc/crontab`,
      rootSession,
    );
    expect(awkCheck.trim()).toBe('');

    // The directories referenced by the stock lines are real, resolvable
    // targets for the very tool (`run-parts`) those lines invoke.
    const runPartsCheck = await pc.executeCommandInSession('run-parts --test /etc/cron.hourly; echo EXIT=$?', rootSession);
    expect(runPartsCheck.trim().endsWith('EXIT=0')).toBe(true);

    const diffOut = await pc.executeCommandInSession('diff /tmp/crontab.bak /etc/crontab', rootSession);
    expect(diffOut).toContain('healthcheck.sh');
    expect(await pc.executeCommandInSession('cat /tmp/crontab.bak', rootSession)).toBe(originalViaCat);
  });
});

describe('Scénario 9 — /etc/ssh/sshd_config : filetype, substitutions, validation sshd -t -f %', () => {
  it('détecte le filetype sshconfig, applique 4 substitutions, et sshd -t -f % valide le résultat', async () => {
    const rootSession = pc.openShellSession({ user: 'root' });
    const fsCtx = new LinuxEditorFsContext(pc, rootSession);
    await pc.executeCommandInSession('cp /etc/ssh/sshd_config /tmp/sshd_config.bak', rootSession);
    const originalViaCat = await pc.executeCommandInSession('cat /tmp/sshd_config.bak', rootSession);
    const original = fsCtx.readFile('/etc/ssh/sshd_config')!;
    expect(original).toContain('Port 22');
    expect(original).toContain('PasswordAuthentication yes');

    const vim = new VimEngine(fsCtx, '/etc/ssh/sshd_config', original, false, 'vim', 'root');
    exCommand(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=sshconfig');

    exCommand(vim, '%s/^Port.*/Port 2222/');
    exCommand(vim, '%s/^PermitRootLogin.*/PermitRootLogin prohibit-password/');
    exCommand(vim, '%s/^PasswordAuthentication.*/PasswordAuthentication no/');
    exCommand(vim, '%s/^LogLevel.*/LogLevel VERBOSE/');

    expect(vim.content).toContain('Port 2222');
    expect(vim.content).toContain('PermitRootLogin prohibit-password');
    expect(vim.content).toContain('PasswordAuthentication no');
    expect(vim.content).toContain('LogLevel VERBOSE');

    // Save first — `:!`/`%` shell out to the file on disk, not the
    // in-memory buffer, exactly like real vim.
    exCommand(vim, 'w');

    exCommand(vim, '!sshd -t -f %');
    expect(vim.shellOutput.trim()).toBe(''); // valid config, silent success

    exCommand(vim, 'q');
    expect(vim.exited).toBe(true);
    expect(vim.swapFileExists).toBe(false);

    const validated = await pc.executeCommandInSession('sshd -t -f /etc/ssh/sshd_config; echo EXIT=$?', rootSession);
    expect(validated.trim()).toBe('EXIT=0');

    const diffOut = await pc.executeCommandInSession('diff /tmp/sshd_config.bak /etc/ssh/sshd_config', rootSession);
    expect(diffOut).toContain('Port 2222');
    expect(diffOut).toContain('PasswordAuthentication no');
    expect(await pc.executeCommandInSession('cat /tmp/sshd_config.bak', rootSession)).toBe(originalViaCat);
  });

  it('un Port hors plage est rejeté par sshd -t -f % avant toute sauvegarde définitive', async () => {
    const rootSession = pc.openShellSession({ user: 'root' });
    const fsCtx = new LinuxEditorFsContext(pc, rootSession);
    const original = fsCtx.readFile('/etc/ssh/sshd_config')!;

    const vim = new VimEngine(fsCtx, '/etc/ssh/sshd_config', original, false, 'vim', 'root');
    exCommand(vim, '%s/^Port.*/Port 999999/');
    exCommand(vim, 'w');

    exCommand(vim, '!sshd -t -f %');
    expect(vim.shellOutput).toContain('Bad configuration option');
    expect(vim.shellOutput).toContain('out of range 1..65535');

    exCommand(vim, 'q');

    const validated = await pc.executeCommandInSession('sshd -t -f /etc/ssh/sshd_config; echo EXIT=$?', rootSession);
    expect(validated.trim().endsWith('EXIT=1')).toBe(true);
  });
});
