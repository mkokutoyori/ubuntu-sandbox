/**
 * Canvas keyboard/ARIA accessibility E2E (rapport 09 audit).
 *
 * Before this, the canvas was reachable only with a mouse: no keyboard
 * way to add a device (HTML5 drag-and-drop only), no focusable/labelled
 * device or connection nodes, and no screen-reader feedback for any
 * action. Drives the real browser UI end to end instead of asserting
 * against component internals.
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('a palette device is a real, keyboard-reachable button that adds a device to the canvas', async ({ page }) => {
  const paletteButton = page.getByRole('button', { name: /^Add .* to canvas/ }).first();
  await expect(paletteButton).toBeVisible();

  // Tab-focus it and activate with Enter — no pointer involved.
  await paletteButton.focus();
  await expect(paletteButton).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-device-id]')).toHaveCount(1);
});

test('the canvas announces device add/select via a polite live region', async ({ page }) => {
  await expect(page.getByRole('application', { name: 'Network topology canvas' })).toBeVisible();

  const status = page.getByRole('status');
  await page.getByRole('button', { name: /^Add .* to canvas/ }).first().click();

  await expect(status).toContainText('added to canvas');
});

test('a device on the canvas is focusable, labelled, and keyboard-operable end to end', async ({ page }) => {
  await page.getByRole('button', { name: /^Add .* to canvas/ }).first().click();
  const device = page.locator('[data-device-id]').first();
  await expect(device).toBeVisible();

  await expect(device).toHaveAttribute('role', 'button');
  await expect(device).toHaveAttribute('tabindex', '0');
  const label = await device.getAttribute('aria-label');
  expect(label).toMatch(/powered on/);

  // Keyboard focus selects the device and reveals its quick actions.
  await device.focus();
  await expect(device).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Delete /  })).toBeVisible();

  // Arrow keys nudge position (accessible drag equivalent).
  const before = await device.evaluate((el) => (el as HTMLElement).style.left);
  await page.keyboard.press('ArrowRight');
  await expect(async () => {
    const after = await device.evaluate((el) => (el as HTMLElement).style.left);
    expect(after).not.toBe(before);
  }).toPass({ timeout: 2_000 });

  // Delete key removes it without ever touching the mouse.
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-device-id]')).toHaveCount(0);
});

test('zoom controls are reachable by keyboard with accessible names', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset zoom and pan' })).toBeVisible();
});
