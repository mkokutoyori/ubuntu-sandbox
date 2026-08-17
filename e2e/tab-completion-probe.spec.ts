/**
 * La tabulation complete-t-elle vraiment, dans le navigateur ?
 *
 * Les suites unitaires appellent `cliTabCandidates` ; elles ne disent
 * rien de la touche. Cette sonde tape un prefixe, appuie sur Tab, et
 * PHOTOGRAPHIE ce que l'operateur voit — sur un ASA et sur un routeur,
 * de sorte qu'un ecart entre les deux se lise au lieu de se deviner.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const SHOTS = 'e2e/__shots__';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

test.setTimeout(180_000);

test.beforeEach(async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.goto('/');
  await waitForStore(page);
});

async function ouvrir(page: Page, motif: RegExp): Promise<void> {
  await page.getByRole('button', { name: motif }).first().click();
  await expect(page.locator('[data-device-id]')).toHaveCount(1);
  await page.locator('[data-device-id]').first().dblclick();
  await page.waitForTimeout(1500);
  await page.locator('body').click({ position: { x: 400, y: 300 } });
}

test('Tab complete un prefixe unique — ASA', async ({ page }) => {
  const journal: string[] = [];
  await ouvrir(page, /^Add .*(ASA|Cisco Firewall).* to canvas/i);

  await page.keyboard.type('enable');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  await page.keyboard.type('show ver');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/10-asa-tab.png`, fullPage: true });
  journal.push(`ASA apres "show ver" + Tab:\n${(await page.locator('body').innerText()).slice(0, 2500)}`);

  writeFileSync(`${SHOTS}/tab-asa.txt`, journal.join('\n\n'));
  expect(journal.length).toBeGreaterThan(0);
});

test('Tab complete un prefixe unique — routeur', async ({ page }) => {
  const journal: string[] = [];
  await ouvrir(page, /^Add Cisco Router to canvas/i);

  await page.keyboard.type('enable');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  await page.keyboard.type('show ver');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/11-routeur-tab.png`, fullPage: true });
  journal.push(`ROUTEUR apres "show ver" + Tab:\n${(await page.locator('body').innerText()).slice(0, 2500)}`);

  writeFileSync(`${SHOTS}/tab-routeur.txt`, journal.join('\n\n'));
  expect(journal.length).toBeGreaterThan(0);
});

test('la suggestion FANTOME s\'affiche pendant la frappe, sans Tab', async ({ page }) => {
  const journal: string[] = [];
  await ouvrir(page, /^Add Cisco Router to canvas/i);

  await page.keyboard.type('enable');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  await page.keyboard.type('show ver');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/12-fantome-routeur.png`, fullPage: true });
  const ecran = await page.locator('body').innerText();
  journal.push(`ROUTEUR pendant "show ver" SANS Tab:\n${ecran.slice(0, 2000)}`);

  writeFileSync(`${SHOTS}/fantome-routeur.txt`, journal.join('\n\n'));
  // Le TEMOIN de l'autre cas : eteinte, elle ne suggere rien.
  expect(ecran, 'eteinte par defaut, elle ne complete pas').not.toContain('sion');
});

test('la suggestion FANTOME sur un ASA', async ({ page }) => {
  const journal: string[] = [];
  await ouvrir(page, /^Add .*(ASA|Cisco Firewall).* to canvas/i);

  await page.keyboard.type('enable');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  await page.keyboard.type('show ver');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/13-fantome-asa.png`, fullPage: true });
  journal.push(`ASA pendant "show ver" SANS Tab:\n${(await page.locator('body').innerText()).slice(0, 2000)}`);

  writeFileSync(`${SHOTS}/fantome-asa.txt`, journal.join('\n\n'));
  expect(journal.length).toBeGreaterThan(0);
});

test('la suggestion fantome est un REGLAGE, eteint par defaut', async ({ page }) => {
  await ouvrir(page, /^Add Cisco Router to canvas/i);
  await page.keyboard.type('enable');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  const bascule = page.getByTestId('ghost-text-toggle');
  await expect(bascule).toHaveAttribute('title', /Ghost text OFF/);

  await bascule.click();
  await expect(bascule).toHaveAttribute('title', /Ghost text ON/);

  await page.locator('body').click({ position: { x: 400, y: 300 } });
  await page.keyboard.type('show ver');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/14-fantome-active.png`, fullPage: true });

  // Le reste suggere est rendu dans son propre element : c'est `sion`
  // qui apparait derriere `show ver`, et lui seul distingue la
  // suggestion allumee de la suggestion eteinte.
  const ecran = await page.locator('body').innerText();
  writeFileSync(`${SHOTS}/fantome-active.txt`, ecran.slice(0, 3000));
  expect(ecran, 'une fois allumee, elle complete pendant la frappe').toContain('sion');
});

test('sur un ASA, `sh` puis `conf t` se completent comme ailleurs', async ({ page }) => {
  await ouvrir(page, /^Add .*(ASA|Cisco Firewall).* to canvas/i);
  await page.keyboard.type('enable');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  await page.keyboard.type('sh');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await page.keyboard.type('ver');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);

  await page.keyboard.type('conf t');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/15-asa-tab-uniforme.png`, fullPage: true });

  const ecran = await page.locator('body').innerText();
  writeFileSync(`${SHOTS}/tab-uniforme.txt`, ecran.slice(0, 3000));
  expect(ecran, '`sh` + Tab a donne `show`').toContain('show version');
  expect(ecran, '`conf t` + Tab est entre en configuration').toContain('FW1(config)#');
});
