import { test, expect } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, modalText, waitForText } from './helpers/ciscoBangLab';

/**
 * Scénario 3 (e2e) — Bannières avec caractères spéciaux (^, %, @,
 * accents, pseudo-graphiques) saisies dans le vrai terminal, puis
 * reproduites à l'identique par show running-config | section banner.
 */

test.describe('Scénario 3 (e2e) — bannières avec caractères spéciaux', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('bannière ASCII-art avec accents et % restituée dans show run', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'banner motd $');
    await waitForText(page, /End with the character '\$'/);
    await typeCmd(page, '╔═══════════════════════════════════════╗');
    await typeCmd(page, '║  RÉSEAU MANDENG - ACCÈS SÉCURISÉ     ║');
    await typeCmd(page, '║  Contact: admin@mandeng.lan          ║');
    await typeCmd(page, '╚═══════════════════════════════════════╝');
    await typeCmd(page, '$');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show running-config | section banner', 600);
    await waitForText(page, '╔═══════════════════════════════════════╗');
    await waitForText(page, 'RÉSEAU MANDENG - ACCÈS SÉCURISÉ');
    await waitForText(page, 'Contact: admin@mandeng.lan');
    await waitForText(page, '╚═══════════════════════════════════════╝');
  });

  test('les lignes % d\'une bannière exec ne déclenchent pas d\'erreur pendant la saisie', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'banner exec $');
    await waitForText(page, /End with the character/);
    await typeCmd(page, '% Attention : session enregistrée');
    await typeCmd(page, '% Durée de session limitée à 30 minutes');
    await typeCmd(page, '$');

    const text = await modalText(page);
    expect(text).not.toContain('% Invalid input detected');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show running-config | section banner', 600);
    await waitForText(page, '% Attention : session enregistrée');
  });
});
