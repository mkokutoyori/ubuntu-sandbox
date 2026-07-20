import { test, expect } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, waitForText } from './helpers/ciscoBangLab';

/**
 * Scénario 4 (e2e) — Copy-paste d'un show running-config en mode
 * configure terminal, ligne à ligne dans le vrai terminal : erreurs
 * non bloquantes sur l'en-tête, ! ignorés, hostname appliqué (visible
 * au prompt), end qui sort du mode config.
 */

test.describe('Scénario 4 (e2e) — copy-paste de configuration avec !', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('le collage complet reproduit le comportement IOS ligne à ligne', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');

    // En-tête de show run : erreur exacte non bloquante.
    await typeCmd(page, 'Building configuration...');
    await waitForText(page, "% Invalid input detected at '^' marker.");
    await typeCmd(page, 'Current configuration : 2847 bytes');
    // ! et commentaires : silencieux.
    await typeCmd(page, '!');
    await typeCmd(page, '! Last configuration change at 08:42:15 UTC');
    // La configuration valide s'applique malgré les erreurs.
    await typeCmd(page, 'hostname SW-MANDENG-01');
    await waitForText(page, /SW-MANDENG-01\(config\)#/);
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'description UPLINK-TO-ROUTER');
    await typeCmd(page, '!');
    // ! ne sort pas du bloc interface :
    await waitForText(page, /SW-MANDENG-01\(config-if\)#/);
    await typeCmd(page, 'interface GigabitEthernet0/1');
    await typeCmd(page, 'description PC-LINUX-1');
    await typeCmd(page, '!');
    // end : sortie immédiate du mode configuration.
    await typeCmd(page, 'end');
    await waitForText(page, /SW-MANDENG-01#/);

    await typeCmd(page, 'show running-config | include description', 600);
    await waitForText(page, 'description UPLINK-TO-ROUTER');
    await waitForText(page, 'description PC-LINUX-1');
  });

  test('end au milieu du collage : la suite échoue en mode EXEC', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'hostname R-PASTE');
    await typeCmd(page, 'end');
    await waitForText(page, /R-PASTE#/);
    await typeCmd(page, 'ip domain-name mandeng.lan');
    await waitForText(page, "% Invalid input detected at '^' marker.");
  });
});
