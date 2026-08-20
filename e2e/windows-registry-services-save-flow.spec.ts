import { test, expect, type Page } from '@playwright/test';

/**
 * Ce qu'un TP Windows a fait à la machine survit à Enregistrer/Ouvrir.
 *
 * La base de registre et le gestionnaire de services ne vivent que sur
 * l'objet `WindowsPC` : aucun fichier ne les décrit, aucun texte de
 * configuration ne les rejoue. Tant que la sérialisation ne les regardait
 * pas, « désactivez le Spooler et posez la stratégie qui l'accompagne »
 * revenait d'un Enregistrer/Ouvrir comme une machine sortie d'usine.
 *
 * Équivalent e2e de
 * `topology-roundtrip-windows-registry-services.test.ts`, joué cette fois
 * dans le vrai navigateur : les commandes sont tapées dans le terminal et
 * le tour passe par les vraies boîtes de dialogue Enregistrer/Ouvrir.
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
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}
async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 8_000 });
}

/** Enregistrer puis rouvrir, par les vraies boîtes de dialogue. */
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

  // La toile n'est pas vide : la confirmation « remplacer ? » s'interpose.
  const replaceConfirm = page.getByRole('alertdialog');
  await expect(replaceConfirm).toBeVisible();
  await replaceConfirm.getByRole('button', { name: 'Replace' }).click();
  await expect(replaceConfirm).toBeHidden();
  await expect(openDialog).toBeHidden();
  await page.waitForTimeout(500);
}

/** L'id du poste rouvert — l'import reconstruit des équipements neufs. */
async function firstDeviceId(page: Page): Promise<string> {
  return (await page.locator('[data-device-id]').first().getAttribute('data-device-id'))!;
}

test.describe('Windows : registre et services survivent à Enregistrer/Ouvrir', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('une valeur de registre posée dans le terminal est encore là après réouverture', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'reg add HKLM\\SOFTWARE\\Lab /v Site /d Douala /f');
    await closeTerminal(page);

    await saveAndReopen(page, `e2e-registre-${Date.now()}`);

    await openTerminal(page, await firstDeviceId(page));
    await typeCmd(page, 'reg query HKLM\\SOFTWARE\\Lab');
    expect(await page.locator('[data-testid="terminal-modal"]').innerText()).toContain('Douala');
  });

  // Un serveur, pas un poste client : `sc config` demande des droits
  // d'administrateur, et une session de terminal s'ouvre sur `User` sur
  // un poste client — comme sur une vraie machine. C'est aussi la machine
  // sur laquelle on fait un TP de services.
  test('un service désactivé et arrêté revient dans cet état', async ({ page }) => {
    const id = await addDevice(page, 'windows-server');
    await openTerminal(page, id);
    await typeCmd(page, 'sc config Spooler start= disabled');
    await typeCmd(page, 'sc stop Spooler');
    await closeTerminal(page);

    await saveAndReopen(page, `e2e-services-${Date.now()}`);

    await openTerminal(page, await firstDeviceId(page));
    await typeCmd(page, 'sc query Spooler');
    await typeCmd(page, 'sc qc Spooler');
    const text = await page.locator('[data-testid="terminal-modal"]').innerText();
    // Sans la capture, la politique de démarrage du SCM relance un service
    // Automatique au boot — et le TP « pourquoi l'impression ne marche
    // plus » n'a plus de panne à diagnostiquer.
    expect(text).toContain('STOPPED');
    expect(text).toContain('DISABLED');
  });
});
