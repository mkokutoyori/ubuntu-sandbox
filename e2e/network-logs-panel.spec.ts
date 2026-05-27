/**
 * Network Logs panel — observability surface for the Logger pub/sub.
 *
 * Verifies the toolbar toggle, that the panel populates as the
 * simulation emits events, and that the filter chips + text query
 * narrow the visible rows.
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

test.describe('Network Logs panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('toolbar button toggles the panel', async ({ page }) => {
    const panel = page.locator('[data-testid="logs-list"]');
    await expect(panel).toHaveCount(0);

    await page.locator('button[title="Logs"]').click();
    await expect(panel).toBeVisible();

    await page.locator('button[title="Logs"]').click();
    await expect(panel).toHaveCount(0);
  });

  test('clicking a row opens the detail drawer with pretty-printed data', async ({ page }) => {
    await page.locator('button[title="Logs"]').click();
    await page.waitForFunction(() => !!(window as Record<string, unknown>).__logger);
    await page.evaluate(() => {
      const Logger = (window as Record<string, unknown>).__logger as {
        info(s: string, e: string, m: string, d?: unknown): void;
      };
      Logger.info('PC1', 'arp:request', 'who-has 192.168.1.2', {
        srcMac: 'aa:bb:cc:dd:ee:ff',
        srcIp: '192.168.1.1',
        targetIp: '192.168.1.2',
      });
    });

    await expect(page.locator('[data-testid="logs-row"]').first()).toBeVisible();
    await page.locator('[data-testid="logs-row"]').first().click();

    const detail = page.locator('[data-testid="logs-detail"]');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('who-has 192.168.1.2');
    await expect(detail).toContainText('"srcMac": "aa:bb:cc:dd:ee:ff"');
    await expect(detail).toContainText('"targetIp": "192.168.1.2"');
    await page.screenshot({ path: 'test-results/logs-panel-detail.png', fullPage: true });

    await page.locator('[data-testid="logs-detail-close"]').click();
    await expect(detail).toHaveCount(0);
  });

  test('panel reflects Logger entries emitted programmatically', async ({ page }) => {
    await page.locator('button[title="Logs"]').click();

    // Drive the underlying Logger singleton — same path equipment uses.
    await page.waitForFunction(() => !!(window as Record<string, unknown>).__logger);
    await page.evaluate(() => {
      const Logger = (window as Record<string, unknown>).__logger as {
        info(s: string, e: string, m: string): void;
      };
      Logger.info('PC1', 'arp:request', 'who-has 192.168.1.2');
      Logger.info('PC2', 'arp:reply',   'is-at aa:bb:cc:dd:ee:ff');
    });

    await expect(page.locator('[data-testid="logs-list"]')).toContainText('arp:request');
    await expect(page.locator('[data-testid="logs-list"]')).toContainText('who-has 192.168.1.2');
    await expect(page.locator('[data-testid="logs-list"]')).toContainText('arp:reply');

    // Filter narrows the visible rows.
    await page.locator('[data-testid="logs-filter"]').fill('reply');
    await expect(page.locator('[data-testid="logs-list"]')).not.toContainText('arp:request');
    await expect(page.locator('[data-testid="logs-list"]')).toContainText('arp:reply');
    await page.screenshot({ path: 'test-results/logs-panel.png', fullPage: true });
  });
});
