import { test, expect, type Page } from '@playwright/test';
import { waitForStore, addDevice, openTerminal } from './helpers/ciscoBangLab';

/**
 * Le collage tient l'interface — vérifié dans le vrai navigateur.
 *
 * Les tests unitaires prouvent que la boucle d'événements obtient des
 * tours ; seul le navigateur montre ce que cela change pour
 * l'utilisateur : les lignes arrivent AU FUR ET À MESURE, et Ctrl-C
 * interrompt. Avant, l'onglet était figé du premier au dernier
 * caractère.
 */

const BLOC = Array.from({ length: 250 }, (_, i) => `no ip host h${i}`).join('\n') + '\n';

/** Colle `text` via un vrai évènement `paste`, comme un Ctrl+V. */
async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  await input.click();
  await input.evaluate((el, payload) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', payload);
    el.dispatchEvent(new ClipboardEvent('paste',
      { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal-modal"]');
    return el ? (el.textContent ?? '') : '';
  }).catch(() => '');
}

test.describe('collage : l\'onglet reste vivant', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('les lignes arrivent au fur et à mesure, pas d\'un seul bloc à la fin', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    await pasteIntoTerminal(page, 'enable\nconfigure terminal\n' + BLOC);

    // Un rendu intermédiaire : le terminal a déjà du texte alors que le
    // collage n'est pas fini. Sans découpe, cette fenêtre n'existait
    // pas — tout apparaissait d'un coup, à la toute fin.
    let vuPendant = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const t = await terminalText(page);
      if (t.includes('no ip host h249')) break;
      if (t.includes('no ip host h0')) { vuPendant = t.length; break; }
      await page.waitForTimeout(50);
    }
    expect(vuPendant, 'aucun rendu intermédiaire : le collage est resté opaque').toBeGreaterThan(0);

    await expect.poll(async () => (await terminalText(page)).includes('no ip host h249'),
      { timeout: 90_000 }).toBe(true);
  });

  // Le Ctrl-C ci-dessous EST la preuve que les entrées atteignent
  // l'application pendant le collage : une touche ne peut être lue que
  // si le thread principal rend la main. Un test séparé « la page
  // répond-elle ? » a été écrit puis retiré — il passait aussi bien
  // avec le défaut présent, et un test qui ne discrimine pas vaut moins
  // que pas de test.
  test('Ctrl-C interrompt un collage lancé par erreur', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    await pasteIntoTerminal(page, 'enable\nconfigure terminal\n' + BLOC);

    await expect.poll(async () => (await terminalText(page)).includes('no ip host h0'),
      { timeout: 30_000 }).toBe(true);
    await page.keyboard.press('Control+c');

    await expect.poll(async () => /Paste aborted/.test(await terminalText(page)),
      { timeout: 30_000 }).toBe(true);
    const texte = await terminalText(page);
    expect(texte, 'le collage a continué après le Ctrl-C').not.toContain('no ip host h249');
  });
});
