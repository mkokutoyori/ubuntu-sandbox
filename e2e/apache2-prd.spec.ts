import { test, expect, type Page } from '@playwright/test';

/**
 * docs/PRD-Manquements.md §M4a in the browser's real terminal.
 *
 * The e2e counterpart of `apache2-really-listens.test.ts` and
 * `apachectl-command.test.ts`. What is checked here and nowhere else: that
 * the operator types these lines themselves and sees the machine's three
 * views — `systemctl`, `ss` and a real connection — finally say the same
 * thing, and that the port-80 conflict with nginx is one an operator can
 * actually run into and read.
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

async function cable(page: Page, a: string, b: string): Promise<void> {
  await page.evaluate(({ from, to }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): {
        addConnection(f: string, fi: string, t: string, ti: string): unknown;
        getDevices(): Array<{ id: string; interfaces: Array<{ name: string }> }>;
      };
    };
    const devices = store.getState().getDevices();
    const src = devices.find((d) => d.id === from)!;
    const dst = devices.find((d) => d.id === to)!;
    store.getState().addConnection(from, src.interfaces[0].name, to, dst.interfaces[0].name);
  }, { from: a, to: b });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(200);
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

const SRV = '10.71.0.10';
const CLI = '10.71.0.20';

test.describe('apache2 in the real terminal', () => {
  test('the three views agree, and another machine really reaches it', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const serverId = await addDevice(page, 'linux-server', 300, 250);
    const clientId = await addDevice(page, 'linux-server', 600, 250);
    await cable(page, serverId, clientId);

    await openTerminal(page, serverId);
    await typeCmd(page, `ip addr add ${SRV}/24 dev eth0`);

    // Stopped: nothing in `ss`. Before §M4a the unit went `active` and the
    // port never opened at all.
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 8)).not.toContain(':80');

    await typeCmd(page, 'systemctl start apache2');
    await typeCmd(page, 'systemctl is-active apache2');
    expect(await lastLines(page, 3)).toContain('active');

    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 8)).toContain(':80');

    await typeCmd(page, 'curl -sS http://127.0.0.1/');
    expect(await lastLines(page, 14)).toContain('It works!');
    await closeTerminal(page);

    await openTerminal(page, clientId);
    await typeCmd(page, `ip addr add ${CLI}/24 dev eth0`);
    await typeCmd(page, `curl -sS http://${SRV}/`);
    expect(await lastLines(page, 14)).toContain('Apache2 Ubuntu Default Page');
  });

  test('nginx holds port 80 and apache2 says why it cannot have it', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'systemctl start nginx');
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 8)).toContain(':80');

    await typeCmd(page, 'systemctl start apache2');
    expect(await lastLines(page, 8)).toContain('AH00072');

    // nginx keeps serving: the one that loses is the one that arrived
    // second, and the operator can read it.
    await typeCmd(page, 'curl -sS http://127.0.0.1/');
    expect(await lastLines(page, 14)).toContain('Welcome to nginx!');

    await typeCmd(page, 'systemctl stop nginx');
    await typeCmd(page, 'systemctl start apache2');
    await typeCmd(page, 'curl -sS http://127.0.0.1/');
    expect(await lastLines(page, 14)).toContain('It works!');
  });

  test('apachectl configtest judges the file, and the start follows its verdict', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'apachectl configtest');
    expect(await lastLines(page, 4)).toContain('Syntax OK');

    await typeCmd(page,
      `sh -c 'printf "<VirtualHost *:80>\\n" > /etc/apache2/sites-available/000-default.conf'`);
    await typeCmd(page, 'apachectl configtest');
    expect(await lastLines(page, 5)).toContain('expected </VirtualHost>');

    await typeCmd(page, 'systemctl start apache2');
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 8)).not.toContain(':80');
  });

  test('apachectl -M follows a module link added and removed by hand', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'apachectl -M');
    expect(await lastLines(page, 30)).toContain('deflate_module (shared)');

    await typeCmd(page, 'rm /etc/apache2/mods-enabled/deflate.load');
    await typeCmd(page, 'apachectl -M');
    expect(await lastLines(page, 30)).not.toContain('deflate_module (shared)');
  });

  test('served requests leave a trace in access.log', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'systemctl start apache2');
    await typeCmd(page, 'curl -sS -o /dev/null http://127.0.0.1/');
    await typeCmd(page, 'curl -sS -o /dev/null http://127.0.0.1/absent.html');

    await typeCmd(page, 'cat /var/log/apache2/access.log');
    const access = await lastLines(page, 8);
    expect(access).toContain('"GET / HTTP/1.1" 200');
    expect(access).toContain('"GET /absent.html HTTP/1.1" 404');
  });
});
