/**
 * Sonde d'interface : un ASA depuis la palette jusqu'au terminal.
 *
 * Les suites unitaires pilotent `executeCommand` ; elles ne disent rien
 * de ce qu'un operateur voit. Cette sonde traverse le chemin reel —
 * palette, canevas, ouverture du terminal, frappe — et CAPTURE l'ecran a
 * chaque etape, parce qu'une commande qui repond correctement dans un
 * test et rien du tout dans un onglet est exactement le genre d'ecart
 * qu'aucune assertion existante ne voit.
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

test('un ASA se pose, s\'ouvre, et repond dans son terminal', async ({ page }) => {
  const journal: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') journal.push(`[console] ${message.text()}`);
  });
  page.on('pageerror', (error) => journal.push(`[pageerror] ${error.message}`));

  const boutons = await page.getByRole('button', { name: /^Add .* to canvas/ })
    .evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label') ?? ''));
  journal.push(`PALETTE: ${JSON.stringify(boutons)}`);

  const ajouter = page.getByRole('button', { name: /^Add .*(ASA|Firewall|Cisco Firewall).* to canvas/i }).first();
  const present = await ajouter.count();
  journal.push(`BOUTON PARE-FEU TROUVE: ${present}`);
  await page.screenshot({ path: `${SHOTS}/01-palette.png`, fullPage: true });

  if (present > 0) {
    await ajouter.click();
    await expect(page.locator('[data-device-id]')).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/02-pose.png`, fullPage: true });

    const carte = page.locator('[data-device-id]').first();
    journal.push(`DEVICE-ID: ${await carte.getAttribute('data-device-id')}`);

    await carte.dblclick();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/03-terminal.png`, fullPage: true });

    const texte = await page.locator('body').innerText();
    journal.push(`ECRAN APRES OUVERTURE:\n${texte.slice(0, 3000)}`);


    await page.locator('body').click({ position: { x: 400, y: 300 } });
    for (const ligne of ['enable', 'show version', 'conf t', 'interface GigabitEthernet0/0']) {
      await page.keyboard.type(ligne);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: `${SHOTS}/04-commandes.png`, fullPage: true });
    journal.push(`APRES COMMANDES:\n${(await page.locator('body').innerText()).slice(0, 4000)}`);

    await page.keyboard.type('nameif inside');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('ip address 192.168.1.1 255.255.255.0');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('show ');
    await page.keyboard.press('?');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/05-aide.png`, fullPage: true });
    journal.push(`APRES AIDE:\n${(await page.locator('body').innerText()).slice(0, 5000)}`);
  }

  writeFileSync(`${SHOTS}/journal.txt`, journal.join('\n\n'));

  const ecran = await page.locator('body').innerText();
  expect(ecran, 'la barre de titre nomme la plateforme reelle').toContain('Cisco ASA');
  expect(ecran, 'et non celle d\'un routeur').not.toContain('Cisco IOS');
  expect(ecran, '`conf t` entre en configuration').toContain('FW1(config)#');
  expect(ecran, '`show ?` decrit les suites, sans repeter `show`').toContain('Display the connection table');
});
