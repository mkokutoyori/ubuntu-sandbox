import { test, expect, type Page } from '@playwright/test';

/**
 * Révoquer, publier, refuser — dans le vrai terminal du navigateur.
 *
 * Le pendant e2e de `openssl-crl-is-opposable.test.ts`. Ce qui se joue
 * ici : l'opérateur voit le MÊME certificat accepté puis refusé, la seule
 * chose ayant changé entre les deux étant sa révocation. C'est le TP que
 * la CRL sert à faire, et il était impossible tant que rien ne consultait
 * la liste.
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

async function buildCa(page: Page): Promise<void> {
  await typeCmd(page, 'mkdir -p /etc/ssl/CA');
  await typeCmd(page,
    'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/CA/ca.key '
    + '-out /etc/ssl/CA/ca.crt -days 365 -nodes -subj "/CN=Lab Root CA"');
  await typeCmd(page, 'openssl genrsa -out /tmp/w.key 2048');
  await typeCmd(page, 'openssl req -new -key /tmp/w.key -out /tmp/w.csr -subj "/CN=www.lab"');
  await typeCmd(page,
    'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
    + '-in /tmp/w.csr -out /tmp/w.crt -days 90');
}

test.describe('la CRL d\'un labo est opposable', () => {
  test('le même certificat est accepté, puis refusé une fois révoqué', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await buildCa(page);

    await typeCmd(page,
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -gencrl -out /tmp/lab.crl');
    await typeCmd(page,
      'openssl verify -crl_check -CAfile /etc/ssl/CA/ca.crt -CRLfile /tmp/lab.crl /tmp/w.crt');
    expect(await lastLines(page, 4)).toContain('/tmp/w.crt: OK');

    await typeCmd(page,
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/w.crt');
    await typeCmd(page,
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -gencrl -out /tmp/lab.crl');

    await typeCmd(page,
      'openssl verify -crl_check -CAfile /etc/ssl/CA/ca.crt -CRLfile /tmp/lab.crl /tmp/w.crt');
    const refus = await lastLines(page, 6);
    expect(refus).toContain('error 23');
    expect(refus).toContain('certificate revoked');
  });

  test('la liste affiche la révocation qu\'elle porte', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await buildCa(page);
    await typeCmd(page,
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/w.crt');
    await typeCmd(page,
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -gencrl -out /tmp/lab.crl');

    await typeCmd(page, 'openssl crl -in /tmp/lab.crl -noout -text');
    const texte = await lastLines(page, 12);
    expect(texte).toContain('Revoked Certificates:');
    expect(texte).toMatch(/Revocation Date: [A-Z][a-z]{2} /);
  });
});
