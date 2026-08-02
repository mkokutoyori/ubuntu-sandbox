import { test, expect, type Page } from '@playwright/test';

/**
 * §F5.2 — ce qu'un `kill -9` laisse derrière lui, dans le vrai terminal.
 *
 * Un `systemctl stop` laisse le démon ranger son fichier PID ; un
 * `kill -9` ne lui laisse rien exécuter, et le fichier survit en nommant
 * un pid mort. Sauf quand systemd possède le répertoire
 * (`RuntimeDirectory=`), auquel cas c'est lui qui nettoie — d'où deux
 * démons de la même machine qui réagissent de façon opposée au même
 * signal.
 *
 * Équivalent e2e de
 * `src/__tests__/unit/network-v2/faults/fault-sigkill-residues.test.ts`.
 */

const SSHD_PID = '/run/sshd.pid';
const F2B_SOCK = '/run/fail2ban/fail2ban.sock';

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

/** Le pid du processus principal d'un service, lu dans `ps aux`. */
async function pidOf(page: Page, exe: string): Promise<string> {
  await typeCmd(page, 'ps aux');
  // Le modal garde tout le scrollback, donc plusieurs `ps aux` s'y
  // empilent : c'est le DERNIER qui décrit la machine maintenant.
  const line = (await modalText(page)).split('\n')
    .filter((l) => l.trimEnd().endsWith(exe) && /^\S+\s+\d+\s/.test(l.trim()))
    .pop();
  expect(line, `aucune ligne ${exe} dans ps aux`).toBeTruthy();
  return line!.trim().split(/\s+/)[1];
}

/** Les dernières lignes seulement — le modal garde tout le scrollback. */
async function lastLines(page: Page, n = 3): Promise<string> {
  return (await modalText(page)).split('\n').slice(-n).join('\n');
}

test.describe('§F5.2 — résidus après un kill -9', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    // Un serveur : son terminal s'ouvre en root.
    await openTerminal(page, await addDevice(page, 'linux-server'));
  });

  test('le fichier PID nomme le processus que `ps` montre', async ({ page }) => {
    const pid = await pidOf(page, '/usr/sbin/sshd -D');
    await typeCmd(page, `cat ${SSHD_PID}`);
    expect(await lastLines(page)).toContain(pid);
  });

  test('un arrêt propre efface le fichier, un démarrage le recrée', async ({ page }) => {
    await typeCmd(page, 'systemctl stop ssh');
    await typeCmd(page, `ls ${SSHD_PID}`);
    expect(await lastLines(page)).toContain('No such file or directory');

    await typeCmd(page, 'systemctl start ssh');

    await typeCmd(page, `cat ${SSHD_PID}`);
    expect(await lastLines(page)).toContain(await pidOf(page, '/usr/sbin/sshd -D'));
  });

  test('fail2ban a bien une RuntimeDirectory, et elle vit avec le service', async ({ page }) => {
    // La fenêtre entre le `kill -9` et la relance dure un RestartSec
    // (0,1 s) — plus court que le temps de frappe d'une commande ici, donc
    // c'est le test unitaire qui l'observe. Ce qui se vérifie dans le
    // navigateur, c'est que la directive est bien là et que le répertoire
    // suit l'état du service.
    await typeCmd(page, 'cat /usr/lib/systemd/system/fail2ban.service');
    expect(await modalText(page)).toContain('RuntimeDirectory=fail2ban');

    await typeCmd(page, `ls ${F2B_SOCK}`);
    expect(await lastLines(page)).toContain(F2B_SOCK);

    await typeCmd(page, 'systemctl stop fail2ban');
    await typeCmd(page, `ls ${F2B_SOCK}`);
    expect(await lastLines(page)).toContain('No such file or directory');
  });

  test('le résidu ne bloque rien : ssh revient avec un nouveau pid', async ({ page }) => {
    const before = await pidOf(page, '/usr/sbin/sshd -D');
    await typeCmd(page, `kill -9 ${before}`);
    await page.waitForTimeout(600); // RestartSec

    await typeCmd(page, 'systemctl is-active ssh');
    expect(await lastLines(page)).toContain('active');
    const after = await pidOf(page, '/usr/sbin/sshd -D');
    expect(after).not.toBe(before);
    // Le fichier a été réécrit : le reliquat n'a rien empêché.
    await typeCmd(page, `cat ${SSHD_PID}`);
    expect(await lastLines(page)).toContain(after);
  });
});
