import { test, expect, type Page } from '@playwright/test';

/**
 * docs/PRD-OpenSSL.md in the browser's real terminal.
 *
 * The e2e counterpart of `openssl-prd-p0-p3.test.ts` and
 * `openssl-enc.test.ts`. What is checked here and nowhere else: that the
 * operator types these lines themselves and that the two tools of the same
 * machine agree — `sha256sum` and `openssl dgst -sha256` return the same
 * digest because they call the same engine, and an `enc` round-trip typed
 * by hand returns exactly what was typed in.
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

test.describe('openssl in the real terminal', () => {
  test('the command exists, and dgst agrees with sha256sum', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'openssl version');
    expect(await lastLines(page, 3)).toContain('OpenSSL 3.0.2');

    await typeCmd(page, `sh -c 'printf "measure me" > /tmp/f.txt'`);
    await typeCmd(page, 'sha256sum /tmp/f.txt');
    const coreutils = (await lastLines(page, 3)).match(/[0-9a-f]{64}/)?.[0];

    await typeCmd(page, 'openssl dgst -sha256 /tmp/f.txt');
    const openssl = (await lastLines(page, 3)).match(/[0-9a-f]{64}/)?.[0];

    // A simulator where the two disagreed would teach that a digest
    // depends on the tool.
    expect(coreutils).toBeTruthy();
    expect(openssl).toBe(coreutils);
  });

  test('an enc round-trip typed by hand returns exactly the input', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, `sh -c 'printf "secret message" > /tmp/plain.txt'`);
    await typeCmd(page,
      'openssl enc -aes-256-cbc -pbkdf2 -a -k passphrase -in /tmp/plain.txt -out /tmp/cipher.b64');

    await typeCmd(page, 'cat /tmp/cipher.b64');
    // `Salted__` in base64 always starts with `U2FsdGVkX1`.
    expect(await lastLines(page, 3)).toContain('U2FsdGVkX1');

    await typeCmd(page,
      'openssl enc -aes-256-cbc -pbkdf2 -a -d -k passphrase -in /tmp/cipher.b64 -out /tmp/back.txt');
    await typeCmd(page, 'cat /tmp/back.txt');
    expect(await lastLines(page, 3)).toContain('secret message');
  });

  test('a wrong password fails instead of returning noise', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, `sh -c 'printf "secret" > /tmp/s.txt'`);
    await typeCmd(page,
      'openssl enc -aes-256-cbc -pbkdf2 -a -k right -in /tmp/s.txt -out /tmp/s.b64');
    await typeCmd(page,
      'openssl enc -aes-256-cbc -pbkdf2 -a -d -k wrong -in /tmp/s.b64');

    expect(await lastLines(page, 5)).toContain('bad decrypt');
  });

  test('a self-signed certificate is written, read back and verified', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'openssl genrsa -out /tmp/key.pem 2048');
    await typeCmd(page, 'cat /tmp/key.pem');
    expect(await lastLines(page, 4)).toContain('BEGIN PRIVATE KEY');

    await typeCmd(page,
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/ca.key -out /tmp/ca.crt '
      + '-days 365 -nodes -subj "/C=FR/O=Lab/CN=Lab Root CA"');
    await typeCmd(page, 'openssl x509 -in /tmp/ca.crt -noout -subject');
    expect(await lastLines(page, 3)).toContain('CN = Lab Root CA');

    await typeCmd(page, 'openssl verify -CAfile /tmp/ca.crt /tmp/ca.crt');
    expect(await lastLines(page, 3)).toContain('OK');
  });
});
