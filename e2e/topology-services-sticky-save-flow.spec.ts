import { test, expect, type Page } from '@playwright/test';

/**
 * Deux TP que la sauvegarde de topologie rendait sains d'eux-mêmes.
 *
 * `systemctl disable` travaille en RETIRANT un lien symbolique, et la
 * capture de fichiers ne consigne que ce qui existe : la panne
 * disparaissait donc du fichier, et la machine rouverte relançait le
 * service. Et un commutateur générique sur la toile faisait carrément
 * ÉCHOUER l'enregistrement de la topologie entière.
 *
 * Équivalent e2e de `topology-roundtrip-services-sticky.test.ts`, joué
 * dans le vrai navigateur, par les vraies boîtes Enregistrer/Ouvrir.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 },
  );
}
async function addDevice(page: Page, type: string, x = 400, y = 300): Promise<string> {
  return page.evaluate(({ t, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, x, y).id;
  }, { t: type, x, y });
}
async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}
async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  // The prompt appears once the machine has finished booting — wait for it
  // rather than for a fixed delay, which is a race on a slow run.
  await input.waitFor({ state: 'attached', timeout: 15_000 });
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(400);
}
/**
 * `sudo` demande son mot de passe dans un champ masqué, rendu hors du
 * cadre visible — d'où `focus()` plutôt que `click()`, le motif de tous
 * les specs à invite de mot de passe de ce dépôt.
 */
async function answerSudoIfAsked(page: Page): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  // sudo caches its timestamp, so only the first call in a session asks.
  if (await input.count() === 0) return;
  await input.focus();
  await input.fill('admin');
  await input.press('Enter');
  await page.waitForTimeout(500);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 8_000 });
}
async function saveAndReopen(page: Page, name: string): Promise<void> {
  await page.locator('button[title="Save"]').click();
  const saveDialog = page.getByRole('dialog');
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByPlaceholder('Topology name').fill(name);
  await saveDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saveDialog).toBeHidden();

  await page.locator('button[title="Open"]').click();
  const openDialog = page.getByRole('dialog', { name: 'Open topology' });
  await expect(openDialog).toBeVisible();
  await openDialog.getByText(name).click();
  const replaceConfirm = page.getByRole('alertdialog');
  await expect(replaceConfirm).toBeVisible();
  await replaceConfirm.getByRole('button', { name: 'Replace' }).click();
  await expect(replaceConfirm).toBeHidden();
  await expect(openDialog).toBeHidden();
  await page.waitForTimeout(500);
}

test.describe('Enregistrer/Ouvrir : services Linux et commutateur générique', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('un service désactivé et arrêté le reste après réouverture', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'sudo systemctl disable ssh');
    await answerSudoIfAsked(page);
    await typeCmd(page, 'sudo systemctl stop ssh');
    await answerSudoIfAsked(page);
    await typeCmd(page, 'systemctl is-active ssh');
    await closeTerminal(page);

    await saveAndReopen(page, `e2e-systemd-${Date.now()}`);

    const reopened = (await page.locator('[data-device-id]').first()
      .getAttribute('data-device-id'))!;
    await openTerminal(page, reopened);
    await typeCmd(page, 'systemctl is-enabled ssh');
    await typeCmd(page, 'systemctl is-active ssh');

    const text = await page.locator('[data-testid="terminal-modal"]').innerText();
    expect(text).toContain('disabled');
    expect(text).toContain('inactive');
  });

  test('un commutateur générique sur la toile n\'empêche plus d\'enregistrer', async ({ page }) => {
    await addDevice(page, 'switch-generic', 300, 200);
    await addDevice(page, 'linux-pc', 500, 400);

    const name = `e2e-generic-sw-${Date.now()}`;
    await page.locator('button[title="Save"]').click();
    const saveDialog = page.getByRole('dialog');
    await saveDialog.getByPlaceholder('Topology name').fill(name);
    await saveDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(saveDialog).toBeHidden();

    // Le vrai critère : le fichier existe et porte les DEUX équipements.
    // Avant, `exportTopology` levait et rien n'était écrit du tout.
    const saved = await page.evaluate(
      (n) => JSON.parse(localStorage.getItem(`ubuntu-sandbox:topology:${n}`) ?? 'null'),
      name,
    );
    expect(saved).not.toBeNull();
    expect(saved.devices).toHaveLength(2);
  });
});
