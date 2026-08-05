import { test, expect, type Page } from '@playwright/test';

/**
 * docs/PRD-Sockets-Une-Seule-Verite.md dans le vrai terminal.
 *
 * Équivalent e2e de `sockets-une-seule-verite.test.ts`. Ce qui se vérifie
 * ici et nulle part ailleurs : que l'opérateur pose lui-même les trois
 * questions du diagnostic réseau — le service tourne-t-il, le port est-il
 * ouvert, la connexion passe-t-elle — et obtienne trois réponses qui
 * s'accordent.
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

test.describe('les deux tables de ports disent la même chose', () => {
  test('un port réellement servi apparaît dans ss, et y disparaît quand il ferme', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const id = await addDevice(page, 'linux-server', 400, 300);
    await openTerminal(page, id);

    // nginx n'écoute pas encore : rien sur le 80.
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 10)).not.toContain(':80');

    await typeCmd(page, 'systemctl start nginx');
    await typeCmd(page, 'ss -ltnp');
    const ouvert = await lastLines(page, 10);
    expect(ouvert).toContain(':80');
    expect(ouvert).toContain('nginx');

    // Et la troisième question du diagnostic donne la même réponse que
    // les deux premières.
    await typeCmd(page, 'curl -sS http://127.0.0.1/');
    expect(await lastLines(page, 12)).toContain('Welcome to nginx!');

    await typeCmd(page, 'systemctl stop nginx');
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 10)).not.toContain(':80');
  });

  test('le stub de systemd-resolved répond vraiment sur le port que ss annonce', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    // `ss` a toujours montré 127.0.0.53:53 en TCP ; jusqu'à §P2 rien
    // n'écoutait derrière, et une connexion dessus était refusée.
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 12)).toContain('127.0.0.53:53');

    await typeCmd(page, 'nc -zv 127.0.0.53 53');
    const verdict = await lastLines(page, 4);
    expect(verdict).not.toContain('refused');
  });

  test('le listener TNS répond dès l\'amorçage, sans commande Oracle préalable', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    // docs/PRD-Manquements.md §M1. Le port 1521 n'était joignable
    // qu'APRÈS qu'une commande Oracle ait été tapée ici même : la base
    // se matérialisait paresseusement, et c'est elle qui attachait
    // l'écoute. Ce cas ne tape donc AUCUNE commande Oracle avant le
    // `nc` — c'est toute sa valeur.
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 12)).toContain(':1521');

    await typeCmd(page, 'nc -zv 127.0.0.1 1521');
    expect(await lastLines(page, 4)).not.toContain('refused');

    // Et `lsnrctl stop` ferme le port pour de bon, des deux côtés.
    await typeCmd(page, 'lsnrctl stop');
    await typeCmd(page, 'ss -ltn');
    expect(await lastLines(page, 12)).not.toContain(':1521');
  });
});
