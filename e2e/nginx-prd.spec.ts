import { test, expect, type Page } from '@playwright/test';

/**
 * docs/PRD-Nginx.md dans le vrai terminal du navigateur.
 *
 * Équivalent e2e de `nginx-prd-p0-p2.test.ts` et `nginx-prd-p3-p4.test.ts`.
 * Ce qui se vérifie ici et nulle part ailleurs : que l'opérateur tape ces
 * lignes lui-même et voit les trois vues de la machine — `systemctl`, `ss`
 * et une vraie connexion — dire enfin la même chose.
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

const SRV = '10.70.0.10';
const CLI = '10.70.0.20';

test.describe('nginx dans le vrai terminal', () => {
  test('les trois vues de la machine s\'accordent, avant et après le démarrage', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const serverId = await addDevice(page, 'linux-server', 300, 250);
    const clientId = await addDevice(page, 'linux-server', 600, 250);
    await cable(page, serverId, clientId);

    await openTerminal(page, serverId);
    await typeCmd(page, `ip addr add ${SRV}/24 dev eth0`);

    // Arrêté : rien dans `ss`, et la connexion est refusée. Avant ce
    // chantier, `ss` montrait `:80` pendant que curl répondait
    // « Connection refused ».
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 8)).not.toContain(':80');

    await typeCmd(page, 'systemctl start nginx');
    await typeCmd(page, 'systemctl is-active nginx');
    expect(await lastLines(page, 3)).toContain('active');

    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 8)).toContain(':80');

    await typeCmd(page, 'curl -sS http://127.0.0.1/');
    expect(await lastLines(page, 12)).toContain('Welcome to nginx!');
    await closeTerminal(page);

    // Et depuis une autre machine, à travers le câble.
    await openTerminal(page, clientId);
    await typeCmd(page, `ip addr add ${CLI}/24 dev eth0`);
    await typeCmd(page, `curl -sS http://${SRV}/`);
    expect(await lastLines(page, 12)).toContain('Welcome to nginx!');
  });

  test('`nginx -t` juge la configuration, et le démarrage suit son verdict', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'nginx -t');
    expect(await lastLines(page, 4)).toContain('test is successful');

    await typeCmd(page, `sh -c 'printf "server {\\n  listen 80;\\n" > /etc/nginx/sites-available/default'`);
    await typeCmd(page, 'nginx -t');
    const verdict = await lastLines(page, 5);
    expect(verdict).toContain('[emerg]');
    expect(verdict).toContain('test failed');

    await typeCmd(page, 'systemctl start nginx');
    await typeCmd(page, 'systemctl is-active nginx');
    // On lit la SORTIE, pas l'écho de la commande : `systemctl is-active`
    // contient lui-même le mot « active », si bien qu'un `not.toContain`
    // sur tout le bloc ne distingue rien.
    const state = (await lastLines(page, 3)).split('\n')
      .find((l) => !l.includes('systemctl') && l.trim().length > 0 && !l.includes('#'));
    expect(state?.trim()).toBe('failed');
  });

  test('changer le fichier puis recharger change ce qui est servi', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'systemctl start nginx');
    await typeCmd(page, 'curl -sS http://127.0.0.1/');
    expect(await lastLines(page, 12)).toContain('Welcome to nginx!');

    await typeCmd(page, 'mkdir -p /srv/site');
    await typeCmd(page, `sh -c 'echo "<h1>ma page</h1>" > /srv/site/index.html'`);
    await typeCmd(page, `sh -c 'printf "server {\\n  listen 80 default_server;\\n  server_name _;\\n  root /srv/site;\\n  index index.html;\\n}\\n" > /etc/nginx/sites-available/default'`);
    await typeCmd(page, 'systemctl reload nginx');

    await typeCmd(page, 'curl -sS http://127.0.0.1/');
    const served = await lastLines(page, 8);
    expect(served).toContain('ma page');
    expect(served).not.toContain('Welcome to nginx!');
  });

  test('les requêtes laissent une trace dans access.log', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'systemctl start nginx');
    await typeCmd(page, 'curl -sS -o /dev/null http://127.0.0.1/');
    await typeCmd(page, 'curl -sS -o /dev/null http://127.0.0.1/absent.html');

    await typeCmd(page, 'cat /var/log/nginx/access.log');
    const access = await lastLines(page, 8);
    expect(access).toContain('"GET / HTTP/1.1" 200');
    expect(access).toContain('"GET /absent.html HTTP/1.1" 404');
  });
});
