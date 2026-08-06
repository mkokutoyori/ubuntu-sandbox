import { test, expect, type Page } from '@playwright/test';

/**
 * Protéger une clé privée par une phrase de passe, dans le vrai terminal
 * du navigateur.
 *
 * Le pendant e2e de `openssl-pkcs8-encrypted.test.ts`. Ce qui se joue ici
 * et nulle part ailleurs : l'opérateur voit de ses yeux la MÊME clé être
 * illisible puis relisible, la seule chose ayant changé entre les deux
 * étant la phrase qu'il fournit. C'est exactement le TP que la commande
 * sert à faire, et il était impossible tant que `-topk8` rendait
 * toujours du clair.
 *
 * Les clés font ici 2048 bits, contrairement aux fixtures vitest : le
 * navigateur n'a pas de budget de 5 s par cas, et une clé de taille
 * réaliste est ce qu'un opérateur taperait. Mesuré, pas supposé.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 },
  );
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ t, px, py }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, px, py).id;
  }, { t: type, px: x, py: y });
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
  await page.waitForTimeout(350);
}

async function lastLines(page: Page, n = 8): Promise<string> {
  const text = await page.locator('[data-testid="terminal-modal"]').innerText();
  return text.split('\n').slice(-n).join('\n');
}

async function poste(page: Page): Promise<void> {
  await page.goto('/', { timeout: 45_000 });
  await waitForStore(page);
  await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));
  await typeCmd(page, 'openssl genrsa -out /tmp/k.pem 2048');
}

test.describe('une clé privée protégée par une phrase de passe', () => {
  test('chiffrée elle est illisible, déchiffrée elle est exactement la même', async ({ page }) => {
    test.setTimeout(180_000);
    await poste(page);

    await typeCmd(page, 'openssl rsa -in /tmp/k.pem -noout -modulus');
    const depart = (await lastLines(page, 4)).match(/Modulus=([0-9A-F]+)/);
    expect(depart).not.toBeNull();

    await typeCmd(page,
      'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/k8.pem -passout pass:secret');
    await typeCmd(page, 'head -1 /tmp/k8.pem');
    expect(await lastLines(page, 4)).toContain('BEGIN ENCRYPTED PRIVATE KEY');

    // La commande ordinaire ne sait pas la lire : c'est le seul sens que
    // « chiffrée » puisse avoir pour l'opérateur.
    await typeCmd(page, 'openssl rsa -in /tmp/k8.pem -noout -modulus');
    expect(await lastLines(page, 4)).toContain('unable to load Private Key');

    await typeCmd(page,
      'openssl pkcs8 -in /tmp/k8.pem -passin pass:secret -out /tmp/rendu.pem');
    await typeCmd(page, 'openssl rsa -in /tmp/rendu.pem -noout -modulus');
    expect(await lastLines(page, 4)).toContain(`Modulus=${depart![1]}`);
  });

  test('la mauvaise phrase échoue, et n\'écrit rien', async ({ page }) => {
    test.setTimeout(180_000);
    await poste(page);

    await typeCmd(page,
      'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/k8.pem -passout pass:secret');
    await typeCmd(page,
      'openssl pkcs8 -in /tmp/k8.pem -passin pass:mauvaise -out /tmp/rendu.pem');
    expect(await lastLines(page, 4)).toContain('bad decrypt');

    await typeCmd(page, 'cat /tmp/rendu.pem');
    expect(await lastLines(page, 4)).toContain('No such file');
  });

  test('sans phrase ni -nocrypt, la commande refuse plutôt que de rendre du clair', async ({ page }) => {
    test.setTimeout(180_000);
    await poste(page);

    await typeCmd(page, 'openssl pkcs8 -topk8 -in /tmp/k.pem -out /tmp/nu.pem');
    expect(await lastLines(page, 4)).toContain('unable to write key');
    await typeCmd(page, 'cat /tmp/nu.pem');
    expect(await lastLines(page, 4)).toContain('No such file');

    // Et `-nocrypt` est la façon de demander explicitement ce que le
    // défaut ne donne plus.
    await typeCmd(page, 'openssl pkcs8 -topk8 -nocrypt -in /tmp/k.pem -out /tmp/clair.pem');
    await typeCmd(page, 'head -1 /tmp/clair.pem');
    const tete = await lastLines(page, 4);
    expect(tete).toContain('BEGIN PRIVATE KEY');
    expect(tete).not.toContain('ENCRYPTED');
  });
});
