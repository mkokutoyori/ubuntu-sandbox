/**
 * Interface language — Playwright.
 *
 * The language switch in the toolbar changes the toolbar, the palette and
 * the help dialog at once, and the choice is still there after a reload.
 */

import { test, expect } from '@playwright/test';

test.describe('interface language', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.clear();
        sessionStorage.setItem('seeded', '1');
      }
    });
    await page.goto('/');
  });

  test('switching to French translates the toolbar, the palette and the help, and survives a reload', async ({ page }) => {
    await expect(page.getByText('Drag to canvas')).toBeVisible();
    await page.getByTestId('language-select').selectOption('fr');
    await expect(page.getByText('Glisser sur le canevas')).toBeVisible();
    await expect(page.getByRole('button', { name: /Exporter/ }).first()).toBeVisible();
    await expect(page.getByText('Commutateurs')).toBeVisible();

    await page.getByRole('button', { name: /Aide/ }).click();
    await expect(page.getByText('Construire une topologie')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.getByText('Glisser sur le canevas')).toBeVisible();
    await expect(page.getByTestId('language-select')).toHaveValue('fr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });

  test('switching back to English restores the original strings', async ({ page }) => {
    await page.getByTestId('language-select').selectOption('fr');
    await page.getByTestId('language-select').selectOption('en');
    await expect(page.getByText('Drag to canvas')).toBeVisible();
    await expect(page.getByText('Switches')).toBeVisible();
  });
});
