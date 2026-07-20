import { test, expect } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, modalText, waitForText } from './helpers/ciscoBangLab';

/**
 * Scénario 6 (e2e) — Hiérarchie d'indentation de show running-config
 * dans le vrai terminal : blocs de niveau 0, enfants indentés d'un
 * espace, séparés par des ! visibles.
 */

test.describe('Scénario 6 (e2e) — indentation et hiérarchie de show run', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('les blocs interface et line vty exposent leurs enfants indentés entre des !', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'hostname SW-MANDENG-01');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'description UPLINK-TO-ROUTER');
    await typeCmd(page, 'ip address 192.168.10.1 255.255.255.0');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'line vty 0 4');
    await typeCmd(page, 'exec-timeout 5 0');
    await typeCmd(page, 'transport input ssh');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show running-config', 700);
    await waitForText(page, 'hostname SW-MANDENG-01');
    await waitForText(page, 'interface GigabitEthernet0/0');
    await waitForText(page, 'description UPLINK-TO-ROUTER');
    await waitForText(page, 'ip address 192.168.10.1 255.255.255.0');
    await waitForText(page, 'line vty 0 4');
    await waitForText(page, 'transport input ssh');

    const text = await modalText(page);
    // Des séparateurs ! seuls sur leur ligne sont visibles.
    expect(/^!$/m.test(text)).toBe(true);
    // La sortie se termine par end.
    expect(text).toContain('end');
    // Jamais de tabulation dans la sortie de show run.
    expect(text.includes('\t')).toBe(false);
  });

  test('| section interface retourne le bloc complet à l\'écran', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'description LIEN PRINCIPAL VERS SWITCH COEUR');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show running-config | section interface', 600);
    await waitForText(page, 'interface GigabitEthernet0/0');
    await waitForText(page, 'description LIEN PRINCIPAL VERS SWITCH COEUR');
  });
});
