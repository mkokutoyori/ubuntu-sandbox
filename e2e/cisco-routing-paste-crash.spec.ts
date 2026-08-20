/**
 * Régression UI — coller un bloc de ~400 lignes de configuration
 * routage IOS dans le terminal d'un routeur Cisco figeait l'onglet.
 *
 * Le collage n'était pas en cause. Le bloc configure `router bgp` avec
 * deux voisins sur des interfaces sans câble, et c'est cette
 * combinaison qui emballait le routeur : la convergence BGP était
 * relancée depuis le chemin de données (avant CHAQUE décision de
 * commutation), donc chaque tentative de session composait à nouveau
 * les voisins ; le SYN mourait en résolution ARP, le routeur
 * fabriquait deux secondes plus tard un ICMP unreachable pour son
 * propre SYN, et router cet ICMP relançait la convergence. Le nombre
 * de tentatives doublait à chaque expiration ARP, chacune laissant un
 * socket bloqué en `syn-sent`, jusqu'à épuisement des ports éphémères
 * — après quoi chaque tentative déversait un `%TCP-4-WARNINGS` dans le
 * terminal. Un demi-million de caractères en quelques secondes, et
 * l'onglet ne répondait plus.
 *
 * Le test surveille les trois formes que prend « le navigateur
 * plante » : onglet tué, exception JS, et thread principal bloqué.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PASTE = readFileSync(join(HERE, 'fixtures/cisco-routing-paste.txt'), 'utf8');
const LAST_LINE = 'show startup-config | section router ospf';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, 400, 250).id;
  }, type);
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
}

/** Colle `text` via un vrai évènement `paste`, comme un Ctrl+V. */
async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.evaluate((el, payload) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', payload);
    el.dispatchEvent(new ClipboardEvent('paste',
      { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

/** Le thread principal répond-il encore dans le délai imparti ? */
async function mainThreadResponds(page: Page, timeoutMs = 5_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const ping = page.evaluate(() => 1 + 1).then((v) => v === 2).catch(() => false);
  const bell = new Promise<boolean>((res) => { timer = setTimeout(() => res(false), timeoutMs); });
  try {
    return await Promise.race([ping, bell]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal-modal"]');
    return el ? (el.textContent ?? '') : '';
  }).catch(() => '');
}

test.describe('collage massif de configuration routage sur un routeur Cisco', () => {
  test("les ~400 lignes se déroulent sans figer l'onglet", async ({ page }) => {
    test.setTimeout(240_000);

    const pageErrors: string[] = [];
    let crashed = false;
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    page.on('crash', () => { crashed = true; });

    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);

    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    await pasteIntoTerminal(page, PASTE);

    // Le collage s'exécute ligne à ligne. On attend qu'il atteigne la
    // dernière commande, en vérifiant à chaque tour que la page vit.
    const deadline = Date.now() + 150_000;
    let alive = true;
    let done = false;
    while (Date.now() < deadline) {
      alive = await mainThreadResponds(page);
      if (!alive || crashed) break;
      if ((await terminalText(page)).includes(LAST_LINE)) { done = true; break; }
      await page.waitForTimeout(1_000);
    }

    expect(crashed, "l'onglet a crashé (renderer tué)").toBe(false);
    expect(alive, 'le thread principal ne répond plus').toBe(true);
    expect(pageErrors, 'exceptions JS pendant le collage').toEqual([]);
    expect(done, 'le collage n\'a jamais atteint sa dernière ligne').toBe(true);

    const text = await terminalText(page);
    // Le collage a réellement configuré le routeur, pas seulement survécu.
    expect(text).toContain('R-ROUTE');
    // Et la tempête de syslog TCP qui noyait le terminal a disparu.
    expect(text).not.toContain('no-ephemeral');
    // Un terminal sain reste de l'ordre de quelques dizaines de milliers
    // de caractères ; la panne en produisait un demi-million en 0,5 s.
    expect(text.length).toBeLessThan(200_000);
  });
});
