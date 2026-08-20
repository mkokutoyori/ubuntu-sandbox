import { test, expect } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, modalText, waitForText } from './helpers/ciscoBangLab';

/**
 * Scénario 1 (e2e) — Le caractère ! dans show running-config, piloté
 * depuis la vraie UI terminal : ! ignoré silencieusement à la saisie,
 * ! séparateur visible dans show run, ! préservé dans une description.
 */

test.describe('Scénario 1 (e2e) — ! séparateur vs ! de valeur', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('un ! tapé en mode config est ignoré sans erreur, et le ! d\'une description survit dans show run', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, '!');
    await typeCmd(page, '! Last configuration change at 08:42:15');

    // Aucune erreur affichée pour les lignes ! :
    const afterBangs = await modalText(page);
    expect(afterBangs).not.toContain("% Invalid input detected");

    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'description LIEN-PRINCIPAL!URGENT');
    await typeCmd(page, '!');
    // Le prompt reste en (config-if) après un ! :
    await waitForText(page, /\(config-if\)#/);
    await typeCmd(page, 'end');

    await typeCmd(page, 'show running-config', 600);
    await waitForText(page, 'description LIEN-PRINCIPAL!URGENT');

    const text = await modalText(page);
    // Des séparateurs ! seuls sont visibles dans la sortie.
    expect(/^!$/m.test(text)).toBe(true);
    expect(text).toContain('interface GigabitEthernet0/0');
  });

  test('username admin!123 : le ! fait partie du nom dans show run', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'username admin!123 privilege 15 secret S3cret');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show running-config | include username', 600);
    await waitForText(page, /username admin!123 privilege 15/);
  });
});
