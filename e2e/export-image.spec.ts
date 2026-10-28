/**
 * Export of the topology as an image — Playwright.
 *
 * Drives the real dialog: the legend is the user's choice (the checkbox
 * decides whether the picture carries it), the language of the picture
 * follows the language chosen in the dialog, and the file that comes out is
 * a real PNG / SVG.
 */

import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

async function addEquipment(page: Page): Promise<void> {
  await page.evaluate(() => {
    type StoreState = { addDevice(type: string, x: number, y: number): unknown };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    store.getState().addDevice('router-cisco', 300, 200);
    store.getState().addDevice('switch-huawei', 300, 360);
    store.getState().addDevice('windows-pc', 200, 520);
  });
}

async function openDialog(page: Page): Promise<void> {
  await page.locator(
    'button[title="Export the topology as an image"], button[title="Exporter la topologie en image"]',
  ).click();
}

async function previewSvg(page: Page): Promise<string> {
  const source = await page.locator('img[alt]').last().getAttribute('src');
  return decodeURIComponent((source ?? '').split(',')[1] ?? '');
}

test.describe('export as image', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await waitForStore(page);
    await addEquipment(page);
  });

  test('the legend is optional and lists the equipment types in use', async ({ page }) => {
    await openDialog(page);
    const checkbox = page.getByRole('checkbox');
    await expect(checkbox).toBeChecked();

    const withLegend = await previewSvg(page);
    expect(withLegend).toMatch(/Cisco Router|Routeur Cisco/);
    expect(withLegend).toMatch(/Huawei Switch|Commutateur Huawei/);
    expect(withLegend).not.toMatch(/FortiGate|Linux Server|Serveur Linux/);

    await checkbox.click();
    const withoutLegend = await previewSvg(page);
    expect(withoutLegend).not.toMatch(/Cisco Router|Routeur Cisco|Legend|Légende/);
    expect(withoutLegend).toContain('>Router1<');
  });

  test('the language of the picture follows the dialog', async ({ page }) => {
    await openDialog(page);
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Français' }).click();
    expect(await previewSvg(page)).toContain('Légende');

    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: 'English' }).click();
    const english = await previewSvg(page);
    expect(english).toContain('>Legend<');
    expect(english).toContain('Cisco Router');
  });

  test('downloads a real PNG', async ({ page }) => {
    await openDialog(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^(Export|Exporter)$/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    const path = await download.path();
    const bytes = await readFile(path);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test('downloads an SVG carrying the legend by default', async ({ page }) => {
    await openDialog(page);
    await page.locator('#export-image-svg').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^(Export|Exporter)$/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.svg$/);
    const text = (await readFile(await download.path())).toString('utf8');
    expect(text.startsWith('<svg')).toBe(true);
    expect(text).toMatch(/Legend|Légende/);
  });

  test('the choice of the legend is remembered', async ({ page }) => {
    await openDialog(page);
    await page.getByRole('checkbox').click();
    await page.getByRole('button', { name: /^(Cancel|Annuler)$/ }).click();
    await openDialog(page);
    await expect(page.getByRole('checkbox')).not.toBeChecked();
  });
});
