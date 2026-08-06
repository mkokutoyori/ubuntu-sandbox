import { test, expect, type Page } from '@playwright/test';

/**
 * `curl --cacert` in the browser's real terminal.
 *
 * The e2e counterpart of `curl-cacert.test.ts`. What is checked here and
 * nowhere else: the operator builds the whole PKI themselves — CA, key,
 * CSR, signature, server — and then reaches their own server WITHOUT `-k`.
 * That last part is the point: a lab whose only way in is to skip
 * verification teaches that verification is optional.
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

async function lastLines(page: Page, n = 14): Promise<string> {
  const text = await page.locator('[data-testid="terminal-modal"]').innerText();
  return text.split('\n').slice(-n).join('\n');
}

/** CA → key → CSR → signature → nginx, every step typed by the operator. */
async function buildLabPki(page: Page): Promise<void> {
  await typeCmd(page, 'mkdir -p /etc/ssl/certs /etc/ssl/private');
  await typeCmd(page,
    'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/ca.key '
    + '-out /etc/ssl/certs/ca.crt -days 365 -nodes -subj "/CN=Lab Root CA"');
  await typeCmd(page, 'openssl genrsa -out /etc/ssl/private/srv.key 2048');
  await typeCmd(page,
    'openssl req -new -key /etc/ssl/private/srv.key -out /tmp/srv.csr -subj "/CN=127.0.0.1"');
  await typeCmd(page,
    'openssl x509 -req -in /tmp/srv.csr -CA /etc/ssl/certs/ca.crt '
    + '-CAkey /etc/ssl/private/ca.key -CAcreateserial -out /etc/ssl/certs/srv.crt -days 90');
  await typeCmd(page,
    `sh -c 'printf "server {\\n  listen 443 ssl;\\n  server_name _;\\n`
    + `  root /var/www/html;\\n  index index.nginx-debian.html;\\n`
    + `  ssl_certificate /etc/ssl/certs/srv.crt;\\n`
    + `  ssl_certificate_key /etc/ssl/private/srv.key;\\n}\\n" `
    + `> /etc/nginx/sites-available/default'`);
  await typeCmd(page, 'systemctl start nginx');
}

test.describe('curl --cacert, typed by the operator', () => {
  test('the lab reaches its own server without skipping verification', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await buildLabPki(page);

    // Without the anchor: refused, and rightly so.
    await typeCmd(page, 'curl -sS https://127.0.0.1/');
    expect(await lastLines(page, 6)).not.toContain('Welcome to nginx!');

    // With the CA the machine itself issued: verified, no `-k` anywhere.
    await typeCmd(page, 'curl -sS --cacert /etc/ssl/certs/ca.crt https://127.0.0.1/');
    expect(await lastLines(page, 14)).toContain('Welcome to nginx!');
  });

  test('the wrong anchor is refused, so --cacert is not a way of saying -k', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await buildLabPki(page);
    await typeCmd(page,
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/other.key '
      + '-out /tmp/other.crt -days 365 -nodes -subj "/CN=Other Root CA"');

    await typeCmd(page, 'curl -sS --cacert /tmp/other.crt https://127.0.0.1/');
    expect(await lastLines(page, 6)).not.toContain('Welcome to nginx!');
  });

  test('a missing anchor file gets curl\'s own error 77', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await buildLabPki(page);

    await typeCmd(page, 'curl -sS --cacert /etc/ssl/certs/absent.crt https://127.0.0.1/');
    expect(await lastLines(page, 6)).toContain('curl: (77)');
  });
});
