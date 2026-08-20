/**
 * Les deux bugs d'acces signales, rejoues dans le VRAI navigateur —
 * puisque les deux se voient sur l'onglet de terminal et nulle part
 * ailleurs. Un test unitaire prouve que le moteur repond juste ; celui-ci
 * prouve que l'apprenant, devant l'ecran, peut faire ce qu'il vient
 * d'apprendre.
 *
 * 1. On pose un `enable password`, on tape `service password-encryption`
 *    comme le cours le demande, et le mode privilegie doit rester
 *    atteignable. Il ne l'etait plus : le mot de passe tape etait compare
 *    a la forme CHIFFREE, donc le bon mot de passe etait refuse pour
 *    toujours.
 *
 * 2. `exit` depuis `#` termine bien la session — c'est le vrai IOS — mais
 *    la console est une ligne soudee, pas une connexion : elle annonce
 *    `<nom> con0 is now available` puis `Press RETURN to get started.` et
 *    attend. L'onglet DISPARAISSAIT, donc le geste qu'on apprend pour
 *    quitter le mode privilegie coupait l'acces a la machine.
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, 400, 250).id;
  }, type);
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function submitPassword(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  await input.focus();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

async function waitForText(page: Page, needle: string | RegExp, timeout = 8_000): Promise<void> {
  await expect.poll(async () => {
    const t = await modalText(page);
    return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
  }, { timeout }).toBe(true);
}

const PLATEFORMES: Array<[string, string]> = [
  ['routeur', 'router-cisco'],
  ['switch', 'switch-cisco'],
];

test.describe('acces : le mot de passe pose ouvre, et la console se repropose', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  for (const [nom, type] of PLATEFORMES) {
    test(`${nom} — \`enable password\` survit a \`service password-encryption\``, async ({ page }) => {
      const id = await addDevice(page, type);
      await openTerminal(page, id);

      await typeCmd(page, 'enable');
      await typeCmd(page, 'configure terminal');
      await typeCmd(page, 'enable password Motdepasse1');
      await typeCmd(page, 'service password-encryption');
      await typeCmd(page, 'end');
      await typeCmd(page, 'disable');

      // La configuration porte bien la forme CHIFFREE — sans quoi ce cas
      // ne mesurerait rien.
      await typeCmd(page, 'enable');
      await submitPassword(page, 'Motdepasse1');
      await typeCmd(page, 'show running-config | include enable password');
      await waitForText(page, /enable password 7 /);

      await typeCmd(page, 'show privilege');
      await waitForText(page, 'Current privilege level is 15');
      expect(await modalText(page)).not.toContain('% Access denied');
    });

    test(`${nom} — un mauvais mot de passe reste refuse`, async ({ page }) => {
      const id = await addDevice(page, type);
      await openTerminal(page, id);

      await typeCmd(page, 'enable');
      await typeCmd(page, 'configure terminal');
      await typeCmd(page, 'enable password Motdepasse1');
      await typeCmd(page, 'service password-encryption');
      await typeCmd(page, 'end');
      await typeCmd(page, 'disable');

      await typeCmd(page, 'enable');
      await submitPassword(page, 'PasLeBon');
      await waitForText(page, '% Access denied');
    });

    test(`${nom} — \`exit\` libere la console au lieu de fermer l'onglet`, async ({ page }) => {
      const id = await addDevice(page, type);
      await openTerminal(page, id);

      await typeCmd(page, 'enable');
      await typeCmd(page, 'exit');

      // L'onglet est toujours la, et il dit ce qu'une vraie machine dit.
      await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible();
      await waitForText(page, 'con0 is now available');
      await waitForText(page, 'Press RETURN to get started.');

      // La frappe rouvre une session — au niveau UTILISATEUR, la
      // precedente ayant rendu ses droits en se terminant.
      const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
      await input.click();
      await input.press('Enter');
      await page.waitForTimeout(400);

      await typeCmd(page, 'show privilege');
      await waitForText(page, /Current privilege level is 1(?!\d)/);
      expect(await modalText(page)).not.toContain('Current privilege level is 15');
    });
  }
});
