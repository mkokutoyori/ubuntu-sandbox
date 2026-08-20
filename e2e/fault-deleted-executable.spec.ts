import { test, expect, type Page } from '@playwright/test';

/**
 * §F5.10 — supprimer l'exécutable d'un démon qui tourne, dans le vrai
 * terminal.
 *
 * La panne différée : `rm /usr/sbin/sshd` ne casse rien sur le moment, le
 * service reste `active`, et la machine ne s'écroule qu'au redémarrage
 * suivant. Seul `/proc/<pid>/exe` la montre pendant qu'elle est encore
 * invisible, avec le suffixe ` (deleted)` que le noyau ajoute.
 *
 * Équivalent e2e de
 * `src/__tests__/unit/network-v2/faults/fault-deleted-executable.test.ts`.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 },
  );
}

async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.waitFor({ state: 'attached', timeout: 15_000 });
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

/** Le pid de sshd, lu dans la sortie de `ps aux` affichée au terminal. */
async function sshdPid(page: Page): Promise<string> {
  await typeCmd(page, 'ps aux');
  const text = await modalText(page);
  // Le modal garde tout le scrollback, y compris l'écho des commandes
  // précédentes : seule une VRAIE ligne de `ps` a un pid numérique en
  // deuxième colonne et la commande complète en fin de ligne.
  const line = text.split('\n')
    .filter((l) => l.trimEnd().endsWith('/usr/sbin/sshd -D'))
    .find((l) => /^\S+\s+\d+\s/.test(l.trim()));
  expect(line, 'aucune ligne sshd dans ps aux').toBeTruthy();
  return line!.trim().split(/\s+/)[1];
}

test.describe('§F5.10 — exécutable supprimé sous un démon qui tourne', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    // Un serveur : son terminal s'ouvre en root, donc `rm` sous /usr/sbin
    // n'a pas besoin d'une élévation à taper au clavier.
    await openTerminal(page, await addDevice(page, 'linux-server'));
  });

  test('le binaire existe, `/proc/<pid>/exe` le désigne', async ({ page }) => {
    await typeCmd(page, 'ls -l /usr/sbin/sshd');
    expect(await modalText(page)).toContain('/usr/sbin/sshd');

    const pid = await sshdPid(page);
    await typeCmd(page, `ls -l /proc/${pid}/exe`);
    expect(await modalText(page)).toContain('-> /usr/sbin/sshd');
  });

  test('après le `rm` : service actif, mais le lien dit (deleted)', async ({ page }) => {
    const pid = await sshdPid(page);
    await typeCmd(page, 'rm /usr/sbin/sshd');

    // Rien ne casse : le processus tourne toujours.
    await typeCmd(page, 'systemctl is-active ssh');
    expect(await modalText(page)).toContain('active');

    // Le seul endroit où la panne est déjà visible.
    await typeCmd(page, `ls -l /proc/${pid}/exe`);
    expect(await modalText(page)).toContain('/usr/sbin/sshd (deleted)');
    await typeCmd(page, `readlink /proc/${pid}/exe`);
    expect(await modalText(page)).toContain('/usr/sbin/sshd (deleted)');
  });

  test('le redémarrage suivant échoue avec 203/EXEC', async ({ page }) => {
    await typeCmd(page, 'rm /usr/sbin/sshd');
    await typeCmd(page, 'systemctl restart ssh');
    expect(await modalText(page))
      .toContain('Job for ssh.service failed because the control process exited');

    await typeCmd(page, 'systemctl status ssh');
    const text = await modalText(page);
    expect(text).toContain('code=exited, status=203/EXEC');
    expect(text).toContain('Active: failed (Result: exit-code)');
  });

  test('remettre le fichier répare le service pour de bon', async ({ page }) => {
    const pid = await sshdPid(page);
    await typeCmd(page, 'rm /usr/sbin/sshd');
    await typeCmd(page, 'systemctl restart ssh');
    await typeCmd(page, 'touch /usr/sbin/sshd');
    await typeCmd(page, 'chmod 755 /usr/sbin/sshd');
    await typeCmd(page, 'systemctl restart ssh');

    await typeCmd(page, 'systemctl is-active ssh');
    expect(await modalText(page)).toContain('active');
    // Le suffixe est recalculé à chaque lecture, donc il disparaît aussi.
    await typeCmd(page, `readlink /proc/${pid}/exe`);
    expect((await modalText(page)).split('\n').slice(-3).join('\n'))
      .not.toContain('(deleted)');
  });
});
