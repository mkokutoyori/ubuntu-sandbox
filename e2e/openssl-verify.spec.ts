import { test, expect, type Page } from '@playwright/test';

/**
 * `openssl verify` dans le vrai terminal du navigateur.
 *
 * Le pendant e2e de `openssl-verify-checks-signature.test.ts`. Ce qui se
 * joue ici et nulle part ailleurs : l'opérateur fabrique DEUX racines du
 * même nom, ce que rien ne lui interdit, et constate que la commande les
 * sépare. Un `verify` qui répondrait `OK` aux deux apprendrait qu'un nom
 * suffit à faire une autorité.
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

async function buildTwoRoots(page: Page): Promise<void> {
  for (const id of ['vraie', 'fausse']) {
    await typeCmd(page,
      `openssl req -x509 -newkey rsa:2048 -keyout /tmp/${id}.key `
      + `-out /tmp/${id}.crt -days 365 -nodes -subj "/CN=Lab Root CA"`);
  }
  await typeCmd(page, 'openssl genrsa -out /tmp/srv.key 2048');
  await typeCmd(page, 'openssl req -new -key /tmp/srv.key -out /tmp/srv.csr -subj "/CN=www.lab"');
  await typeCmd(page,
    'openssl x509 -req -in /tmp/srv.csr -CA /tmp/vraie.crt -CAkey /tmp/vraie.key '
    + '-CAcreateserial -out /tmp/srv.crt -days 90');
}

test.describe('openssl verify, deux racines du même nom', () => {
  test('la vraie approuve, l\'homonyme est refusée avec l\'erreur 7', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await buildTwoRoots(page);

    await typeCmd(page, 'openssl verify -CAfile /tmp/vraie.crt /tmp/srv.crt');
    expect(await lastLines(page, 4)).toContain('/tmp/srv.crt: OK');

    await typeCmd(page, 'openssl verify -CAfile /tmp/fausse.crt /tmp/srv.crt');
    const refus = await lastLines(page, 6);
    expect(refus).toContain('error 7');
    expect(refus).toContain('verification failed');
  });

  test('un faisceau de plusieurs racines approuve par n\'importe laquelle', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page,
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/a.key -out /tmp/a.crt '
      + '-days 365 -nodes -subj "/CN=CA A"');
    await typeCmd(page,
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/b.key -out /tmp/b.crt '
      + '-days 365 -nodes -subj "/CN=CA B"');
    await typeCmd(page, 'openssl genrsa -out /tmp/srv.key 2048');
    await typeCmd(page, 'openssl req -new -key /tmp/srv.key -out /tmp/srv.csr -subj "/CN=www.lab"');
    await typeCmd(page,
      'openssl x509 -req -in /tmp/srv.csr -CA /tmp/b.crt -CAkey /tmp/b.key '
      + '-CAcreateserial -out /tmp/srv.crt -days 90');
    await typeCmd(page, 'cat /tmp/a.crt /tmp/b.crt > /tmp/bundle.crt');

    await typeCmd(page, 'openssl verify -CAfile /tmp/bundle.crt /tmp/srv.crt');
    expect(await lastLines(page, 4)).toContain('/tmp/srv.crt: OK');
  });
});
