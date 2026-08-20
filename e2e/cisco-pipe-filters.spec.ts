import { test, expect } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, modalText, waitForText } from './helpers/ciscoBangLab';

/**
 * Scénario 7 (e2e) — Filtres de pipe Cisco (| include, | section,
 * | begin, | exclude) exécutés dans le vrai terminal de l'UI.
 */

async function buildConfig(page: import('@playwright/test').Page): Promise<void> {
  await typeCmd(page, 'enable');
  await typeCmd(page, 'configure terminal');
  await typeCmd(page, 'hostname SW-MANDENG-01');
  await typeCmd(page, 'interface GigabitEthernet0/0');
  await typeCmd(page, 'description UPLINK');
  await typeCmd(page, 'exit');
  await typeCmd(page, 'line vty 0 4');
  await typeCmd(page, 'transport input ssh');
  await typeCmd(page, 'exit');
  await typeCmd(page, 'end');
}

test.describe('Scénario 7 (e2e) — filtres de pipe sur show running-config', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('| include interface : lignes seules, sans les enfants', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    await buildConfig(page);

    await typeCmd(page, 'show running-config | include interface', 600);
    await waitForText(page, 'interface GigabitEthernet0/0');
    const text = await modalText(page);
    // La description (enfant) n'apparaît pas dans la sortie du include.
    const afterFilter = text.slice(text.lastIndexOf('| include interface'));
    expect(afterFilter).not.toContain('description UPLINK');
  });

  test('| section line vty : bloc complet avec ses enfants', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    await buildConfig(page);

    await typeCmd(page, 'show running-config | section line vty', 600);
    await waitForText(page, 'line vty 0 4');
    await waitForText(page, 'transport input ssh');
  });

  test('| begin line : tout depuis la première ligne line jusqu\'à end', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    await buildConfig(page);

    await typeCmd(page, 'show running-config | begin line', 600);
    await waitForText(page, 'line vty 0 4');
    const text = await modalText(page);
    const afterFilter = text.slice(text.lastIndexOf('| begin line'));
    // hostname est AVANT la section line : exclu de la sortie begin.
    expect(afterFilter).not.toContain('hostname SW-MANDENG-01');
    expect(afterFilter).toContain('end');
  });

  test('| exclude ! : configuration compacte sans séparateurs', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
    await buildConfig(page);

    await typeCmd(page, 'show running-config | exclude !', 600);
    await waitForText(page, 'hostname SW-MANDENG-01');
    const text = await modalText(page);
    const afterFilter = text.slice(text.lastIndexOf('| exclude !'));
    expect(/^!$/m.test(afterFilter)).toBe(false);
  });
});
