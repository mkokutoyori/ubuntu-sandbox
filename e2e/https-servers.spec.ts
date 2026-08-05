import { test, expect, type Page } from '@playwright/test';

/**
 * docs/PRD-Nginx.md §P5 and its Apache twin, in the browser's real
 * terminal.
 *
 * The e2e counterpart of `nginx-prd-p5-https.test.ts` and
 * `apache2-https.test.ts`. What is checked here and nowhere else: that an
 * operator types the whole lab themselves — generate a certificate, point
 * a server at it, watch the port open — and that the two ways of getting
 * it wrong (no certificate, wrong certificate) leave the port SHUT rather
 * than answering in the clear on 443.
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

const MAKE_CERT =
  'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/lab.key '
  + '-out /etc/ssl/certs/lab.crt -days 365 -nodes -subj "/CN=lab.local"';

const NGINX_SSL_SITE =
  `sh -c 'printf "server {\\n  listen 443 ssl;\\n  server_name _;\\n`
  + `  root /var/www/html;\\n  index index.nginx-debian.html;\\n`
  + `  ssl_certificate /etc/ssl/certs/lab.crt;\\n`
  + `  ssl_certificate_key /etc/ssl/private/lab.key;\\n}\\n" `
  + `> /etc/nginx/sites-available/default'`;

test.describe('HTTPS, typed by the operator', () => {
  test('the certificate and the key the machine produced actually match', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'mkdir -p /etc/ssl/certs /etc/ssl/private');
    await typeCmd(page, MAKE_CERT);

    // The canonical check an admin runs to pair a key with its
    // certificate. It answered "no" for a matching pair until §P5.
    await typeCmd(page, 'openssl x509 -in /etc/ssl/certs/lab.crt -noout -modulus');
    const fromCert = (await lastLines(page, 3)).match(/Modulus=\S+/)?.[0];
    await typeCmd(page, 'openssl rsa -in /etc/ssl/private/lab.key -noout -modulus');
    const fromKey = (await lastLines(page, 3)).match(/Modulus=\S+/)?.[0];

    expect(fromCert).toBeTruthy();
    expect(fromKey).toBe(fromCert);
  });

  test('nginx serves 443 over a real handshake', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'mkdir -p /etc/ssl/certs /etc/ssl/private');
    await typeCmd(page, MAKE_CERT);
    await typeCmd(page, NGINX_SSL_SITE);

    await typeCmd(page, 'nginx -t');
    expect(await lastLines(page, 4)).toContain('test is successful');

    await typeCmd(page, 'systemctl start nginx');
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 10)).toContain(':443');

    await typeCmd(page, 'curl -sS -k https://127.0.0.1/');
    expect(await lastLines(page, 14)).toContain('Welcome to nginx!');
  });

  test('a self-signed certificate is refused without -k', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'mkdir -p /etc/ssl/certs /etc/ssl/private');
    await typeCmd(page, MAKE_CERT);
    await typeCmd(page, NGINX_SSL_SITE);
    await typeCmd(page, 'systemctl start nginx');

    await typeCmd(page, 'curl -sS https://127.0.0.1/');
    const refused = await lastLines(page, 6);
    expect(refused).not.toContain('Welcome to nginx!');
    expect(refused).toMatch(/certificate|SSL/i);
  });

  test('a deleted certificate leaves 443 shut, never cleartext', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'mkdir -p /etc/ssl/certs /etc/ssl/private');
    await typeCmd(page, MAKE_CERT);
    await typeCmd(page, NGINX_SSL_SITE);
    await typeCmd(page, 'rm /etc/ssl/certs/lab.crt');
    await typeCmd(page, 'systemctl start nginx');

    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 10)).not.toContain(':443');

    await typeCmd(page, 'cat /var/log/nginx/error.log');
    expect(await lastLines(page, 6)).toContain('/etc/ssl/certs/lab.crt');
  });

  test('apache2 ships default-ssl disabled, and enabling it as-is says why it cannot start', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'ls /etc/apache2/sites-enabled');
    expect(await lastLines(page, 4)).not.toContain('default-ssl.conf');

    // `a2ensite default-ssl` is only an `ln -s`.
    await typeCmd(page,
      'ln -s ../sites-available/default-ssl.conf /etc/apache2/sites-enabled/default-ssl.conf');
    await typeCmd(page, 'systemctl start apache2');

    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 10)).not.toContain(':443');

    await typeCmd(page, 'cat /var/log/apache2/error.log');
    expect(await lastLines(page, 6)).toContain('ssl-cert-snakeoil');
  });
});
