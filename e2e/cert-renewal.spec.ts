import { test, expect, type Page } from '@playwright/test';

/**
 * Renewing a certificate and reloading, in the browser's real terminal.
 *
 * The e2e counterpart of `https-cert-renewal.test.ts`. What is checked
 * here and nowhere else: that the operator performs the whole renewal
 * themselves — reissue, reload, request — and that the server is really
 * serving the new pair afterwards rather than the one it started with.
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

function issue(cn: string): string {
  return 'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/lab.key '
    + `-out /etc/ssl/certs/lab.crt -days 365 -nodes -subj "/CN=${cn}"`;
}

const NGINX_SSL_SITE =
  `sh -c 'printf "server {\\n  listen 443 ssl;\\n  server_name _;\\n`
  + `  root /var/www/html;\\n  index index.nginx-debian.html;\\n`
  + `  ssl_certificate /etc/ssl/certs/lab.crt;\\n`
  + `  ssl_certificate_key /etc/ssl/private/lab.key;\\n}\\n" `
  + `> /etc/nginx/sites-available/default'`;

test.describe('certificate renewal, typed by the operator', () => {
  test('reload really serves the renewed pair', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'mkdir -p /etc/ssl/certs /etc/ssl/private');
    await typeCmd(page, issue('old.lab'));
    await typeCmd(page, NGINX_SSL_SITE);
    await typeCmd(page, 'systemctl start nginx');
    await typeCmd(page, 'curl -sS -k https://127.0.0.1/');
    expect(await lastLines(page, 14)).toContain('Welcome to nginx!');

    // Renew in place, exactly as certbot would.
    await typeCmd(page, issue('new.lab'));
    await typeCmd(page, 'openssl x509 -in /etc/ssl/certs/lab.crt -noout -subject');
    expect(await lastLines(page, 3)).toContain('CN = new.lab');

    await typeCmd(page, 'systemctl reload nginx');

    // Observe the certificate PRESENTED, not merely that TLS works: the
    // old pair is consistent with itself and negotiates just as happily,
    // so only the peer subject tells the two apart.
    await typeCmd(page, 'curl -sS -v -k https://127.0.0.1/');
    expect(await lastLines(page, 20)).toContain('new.lab');
  });

  test('a botched renewal keeps the site up instead of going dark', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'mkdir -p /etc/ssl/certs /etc/ssl/private');
    await typeCmd(page, issue('good.lab'));
    await typeCmd(page, NGINX_SSL_SITE);
    await typeCmd(page, 'systemctl start nginx');

    // The classic mistake: the file is replaced by something that is not a
    // certificate.
    await typeCmd(page, `sh -c 'printf "junk\\n" > /etc/ssl/certs/lab.crt'`);

    // The check an operator runs before reloading — and it must FAIL,
    // which is what keeps the reload from dismantling a working site.
    await typeCmd(page, 'nginx -t');
    expect(await lastLines(page, 5)).not.toContain('test is successful');

    await typeCmd(page, 'systemctl reload nginx');
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 10)).toContain(':443');
    await typeCmd(page, 'curl -sS -k https://127.0.0.1/');
    expect(await lastLines(page, 14)).toContain('Welcome to nginx!');
  });
});
