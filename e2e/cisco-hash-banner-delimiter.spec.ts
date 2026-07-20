import { test, expect } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, modalText, waitForText } from './helpers/ciscoBangLab';

/**
 * Scénario 2 (e2e) — # prompt, # délimiteur de bannière, # dans le
 * contenu (troncature) : saisie multi-lignes dans le vrai terminal et
 * représentation ^C dans show running-config.
 */

test.describe('Scénario 2 (e2e) — # délimiteur de bannière vs prompt', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('bannière multi-lignes saisie au #, affichée en ^C dans show run | section banner', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await waitForText(page, /#/);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'banner motd #');
    await waitForText(page, /End with the character '#'/);
    await typeCmd(page, 'Bienvenue sur le routeur Mandeng');
    await typeCmd(page, 'Contact: admin@mandeng.lan');
    await typeCmd(page, '#');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show running-config | section banner', 600);
    await waitForText(page, 'banner motd ^C');
    await waitForText(page, 'Bienvenue sur le routeur Mandeng');
    await waitForText(page, 'Contact: admin@mandeng.lan');
    const text = await modalText(page);
    // Dans la SORTIE de show run (après la commande filtrée), le
    // délimiteur # saisi n'apparaît plus : uniquement ^C. (La commande
    // `banner motd #` tapée plus haut reste visible dans l'historique
    // du terminal, elle.)
    const output = text.slice(text.lastIndexOf('| section banner'));
    expect(output).not.toContain('banner motd #');
    expect(output).toContain('banner motd ^C');
  });

  test('le # dans le contenu tronque la bannière : la suite devient des commandes invalides', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'banner motd #');
    await waitForText(page, /End with the character/);
    await typeCmd(page, 'Ticket: #INC-001');
    // La bannière est fermée sur ce # : la ligne suivante est une
    // commande inconnue.
    await typeCmd(page, 'Suite du message');
    await waitForText(page, "% Invalid input detected at '^' marker.");
    await typeCmd(page, 'end');
  });
});
