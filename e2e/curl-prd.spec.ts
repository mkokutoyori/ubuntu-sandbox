import { test, expect, type Page } from '@playwright/test';

/**
 * docs/PRD-Curl.md dans le vrai terminal du navigateur.
 *
 * Équivalent e2e de `curl-prd-p0-p1.test.ts`, `curl-prd-p2-p3.test.ts` et
 * `curl-one-engine-two-platforms.test.ts`. Ce qui se vérifie ici et nulle
 * part ailleurs : que l'opérateur tape vraiment ces lignes, que `$?` est
 * lisible depuis le shell qu'il utilise, et que la même commande existe des
 * deux côtés — Linux et Windows — puisque `curl` est livré avec les deux
 * systèmes.
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

test.describe('curl dans le terminal Linux', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-pc', 400, 300));
  });

  test('une option inconnue est refusée, avec le code 2', async ({ page }) => {
    await typeCmd(page, 'curl -Z http://10.0.0.1/');
    expect(await lastLines(page, 6)).toContain('curl: option -Z: is unknown');

    await typeCmd(page, 'echo $?');
    expect(await lastLines(page, 3)).toContain('2');
  });

  test('une option connue de curl mais non implémentée ici le dit', async ({ page }) => {
    await typeCmd(page, 'curl -x http://proxy:3128 http://10.0.0.1/');
    expect(await lastLines(page, 6)).toContain('is not implemented in this simulator');
  });

  test('un protocole hors périmètre est refusé, pas simulé', async ({ page }) => {
    await typeCmd(page, 'curl ftp://ftp.example.com/pub/x');
    expect(await lastLines(page, 5))
      .toContain('curl: (1) Protocol "ftp" not supported or disabled in libcurl');
  });

  test('rien n\'écoute : (7), et `|| echo KO` se déclenche', async ({ page }) => {
    await typeCmd(page, 'curl -sS http://127.0.0.1:8080/ || echo KO');
    const out = await lastLines(page, 6);
    expect(out).toContain('curl: (7)');
    expect(out).toContain('KO');
  });

  test('-s tait l\'erreur, -sS la rétablit', async ({ page }) => {
    await typeCmd(page, 'curl -s http://127.0.0.1:8080/');
    expect(await lastLines(page, 3)).not.toContain('curl: (7)');

    await typeCmd(page, 'curl -sS http://127.0.0.1:8080/');
    expect(await lastLines(page, 4)).toContain('curl: (7)');
  });

  test('un nom introuvable donne (6) et le code 6', async ({ page }) => {
    await typeCmd(page, 'curl http://nowhere.invalid/');
    expect(await lastLines(page, 4)).toContain('curl: (6) Could not resolve host: nowhere.invalid');

    await typeCmd(page, 'echo $?');
    expect(await lastLines(page, 3)).toContain('6');
  });

  test('sans URL, curl renvoie sa ligne d\'usage', async ({ page }) => {
    await typeCmd(page, 'curl');
    expect(await lastLines(page, 4)).toContain("curl: try 'curl --help' for more information");
  });
});

test.describe('curl existe aussi sur Windows, et dit la même chose', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'windows-pc', 400, 300));
  });

  test('cmd.exe connaît la commande', async ({ page }) => {
    await typeCmd(page, 'curl http://nowhere.invalid/');
    const out = await lastLines(page, 5);
    expect(out).not.toContain('is not recognized');
    expect(out).toContain('curl: (6) Could not resolve host: nowhere.invalid');
  });

  test('le même refus d\'option inconnue qu\'un poste Linux', async ({ page }) => {
    await typeCmd(page, 'curl -Z http://10.0.0.1/');
    const out = await lastLines(page, 6);
    expect(out).toContain('curl: option -Z: is unknown');
    expect(out).toContain("curl: try 'curl --help' for more information");
  });

  test('le même refus de protocole', async ({ page }) => {
    await typeCmd(page, 'curl ftp://files.example.com/x');
    expect(await lastLines(page, 5))
      .toContain('curl: (1) Protocol "ftp" not supported or disabled in libcurl');
  });

  test('curl.exe est la même commande', async ({ page }) => {
    await typeCmd(page, 'curl.exe http://nowhere.invalid/');
    expect(await lastLines(page, 5)).toContain('curl: (6) Could not resolve host');
  });
});

test.describe('un transfert réel entre deux machines du canevas', () => {
  test('la page servie par IIS arrive dans le terminal Linux, et le verbe est honoré', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const serverId = await addDevice(page, 'windows-server', 300, 250);
    // Un serveur Linux : son terminal s'ouvre en root, donc `ip addr add`
    // n'ouvre pas l'invite de mot de passe de `sudo` — qui remplace le
    // champ de saisie et bloque la suite du scénario.
    const clientId = await addDevice(page, 'linux-server', 600, 250);

    await page.evaluate(({ a, b }) => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): {
          addConnection(fromId: string, fromIf: string, toId: string, toIf: string): unknown;
          getDevices(): Array<{ id: string; interfaces: Array<{ name: string }> }>;
        };
      };
      const devices = store.getState().getDevices();
      const from = devices.find((d) => d.id === a)!;
      const to = devices.find((d) => d.id === b)!;
      store.getState().addConnection(a, from.interfaces[0].name, b, to.interfaces[0].name);
    }, { a: serverId, b: clientId });

    await openTerminal(page, serverId);
    await typeCmd(page, 'netsh interface ip set address "Ethernet0" static 10.50.0.10 255.255.255.0');
    await typeCmd(page, 'powershell -Command "Install-WindowsFeature Web-Server"');
    await closeTerminal(page);

    await openTerminal(page, clientId);
    await typeCmd(page, 'ip addr add 10.50.0.20/24 dev eth0');
    await typeCmd(page, 'curl -sS http://10.50.0.10/');
    expect(await lastLines(page, 8)).toContain('IIS Windows Server');

    await typeCmd(page, 'curl -sS -i -X DELETE http://10.50.0.10/');
    const refused = await lastLines(page, 10);
    expect(refused).toContain('405 Method Not Allowed');
    expect(refused).toContain('Allow: GET, HEAD, OPTIONS, TRACE');
  });
});
