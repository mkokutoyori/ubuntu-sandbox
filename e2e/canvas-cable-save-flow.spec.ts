/**
 * Real UI flow: place two devices, cable them via the Connect gesture,
 * then round-trip the topology through Save/Open (rapport 09, item #57).
 *
 * Every other spec that builds a lab seeds it through
 * `store.getState().addDevice/addConnection` in `page.evaluate` and only
 * drives the terminal/CLI layer for real — nothing exercises the actual
 * click-to-connect gesture (Connect button -> source popover -> click
 * target device -> target popover) or the Save/Open dialogs (item #54/#55)
 * through the browser. This drives that operator-facing path end to end.
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test('drag two PCs onto the canvas, cable them via Connect, then save and reopen the topology', async ({ page }) => {
  const addPcButton = page.getByRole('button', { name: /^Add Linux PC to canvas/ });
  await addPcButton.click();
  await addPcButton.click();
  await expect(page.locator('[data-device-id]')).toHaveCount(2);

  const deviceCards = page.locator('[data-device-id]');
  const pc1 = deviceCards.nth(0);
  const pc2 = deviceCards.nth(1);

  // Select PC1 and start a connection from it.
  await pc1.click();
  await page.getByRole('button', { name: /^Connect .* to another device$/ }).click();

  // Interface rows only — excludes the popover's own Cancel/X button,
  // which precedes them in DOM order and would otherwise match first.
  const interfaceRow = 'button:not([disabled]):not([aria-label="Cancel interface selection"])';

  const sourcePopover = page.getByRole('dialog', { name: /^Select source interface on/ });
  await expect(sourcePopover).toBeVisible();
  await sourcePopover.locator(interfaceRow).first().click();

  // Clicking PC2 while connecting opens its target selector directly,
  // without going through selection/Connect again.
  await pc2.click();
  const targetPopover = page.getByRole('dialog', { name: /^Select target interface on/ });
  await expect(targetPopover).toBeVisible();
  await targetPopover.locator(interfaceRow).first().click();

  await expect(page.locator('[role="status"]')).toHaveText('Devices connected');
  const connectionCountAfterCabling = await page.evaluate(
    () => (window as any).__networkStore.getState().connections.length,
  );
  expect(connectionCountAfterCabling).toBe(1);

  // Save through the real dialog (item #54), not a direct store call.
  const topologyName = `e2e-cable-save-${Date.now()}`;
  await page.locator('button[title="Save"]').click();
  const saveDialog = page.getByRole('dialog');
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByPlaceholder('Topology name').fill(topologyName);
  await saveDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saveDialog).toBeHidden();

  // The dialog only calls the real exportTopology()/saveTopologyToBrowser()
  // path — assert the actual persisted payload, not just that a function
  // ran, to prove the device/cable the user just built round-trips.
  const saved = await page.evaluate(
    (name) => JSON.parse(localStorage.getItem(`ubuntu-sandbox:topology:${name}`) ?? 'null'),
    topologyName,
  );
  expect(saved).not.toBeNull();
  expect(saved.devices).toHaveLength(2);
  expect(saved.connections).toHaveLength(1);

  // Open it back through the real dialog. The canvas isn't empty, so
  // this must hit the "replace current topology?" confirm added by item
  // #55 — a second, stacked dialog (role="alertdialog", distinct from
  // the Dialog picker underneath it).
  await page.locator('button[title="Open"]').click();
  const openDialog = page.getByRole('dialog', { name: 'Open topology' });
  await expect(openDialog).toBeVisible();
  await openDialog.getByText(topologyName).click();

  const replaceConfirm = page.getByRole('alertdialog');
  await expect(replaceConfirm).toBeVisible();
  await replaceConfirm.getByRole('button', { name: 'Replace' }).click();
  await expect(replaceConfirm).toBeHidden();
  await expect(openDialog).toBeHidden();

  // The reopened topology must show the same shape it was saved with.
  await expect(page.locator('[data-device-id]')).toHaveCount(2);
  const connectionCountAfterReopen = await page.evaluate(
    () => (window as any).__networkStore.getState().connections.length,
  );
  expect(connectionCountAfterReopen).toBe(1);
});
