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

  test('live-tail pauses when the user scrolls into history and resumes on toggle', async ({ page }) => {
    await page.locator('button[title="Logs"]').click();
    await page.waitForFunction(() => !!(window as Record<string, unknown>).__logger);

    // Seed 80 rows so the list overflows and we can actually scroll.
    await page.evaluate(() => {
      const Logger = (window as Record<string, unknown>).__logger as {
        info(s: string, e: string, m: string): void;
      };
      for (let i = 0; i < 80; i++) Logger.info(`PC${i % 4}`, 'frame:sent', `seq=${i}`);
    });

    // At the top: live mode, no paused badge.
    await expect(page.locator('[data-testid="logs-paused-badge"]')).toHaveCount(0);

    // Scroll down inside the list → live mode pauses.
    await page.locator('[data-testid="logs-list"]').evaluate(el => { el.scrollTop = 200; });
    await expect(page.locator('[data-testid="logs-paused-badge"]')).toBeVisible();

    // While paused, new logs do NOT yank the viewport back to 0.
    const scrollTopBefore = await page.locator('[data-testid="logs-list"]').evaluate(el => el.scrollTop);
    await page.evaluate(() => {
      const Logger = (window as Record<string, unknown>).__logger as {
        info(s: string, e: string, m: string): void;
      };
      for (let i = 0; i < 10; i++) Logger.info('PC0', 'frame:sent', `late-${i}`);
    });
    await page.waitForTimeout(200);
    const scrollTopAfter = await page.locator('[data-testid="logs-list"]').evaluate(el => el.scrollTop);
    expect(scrollTopAfter).toBe(scrollTopBefore);

    // Clicking the tail toggle resumes and snaps back to 0.
    await page.locator('[data-testid="logs-toggle-tail"]').click();
    await expect(page.locator('[data-testid="logs-paused-badge"]')).toHaveCount(0);
    await expect.poll(
      () => page.locator('[data-testid="logs-list"]').evaluate(el => el.scrollTop),
    ).toBe(0);
  });

  test('export buttons download visible rows as JSON and CSV', async ({ page }) => {
    await page.locator('button[title="Logs"]').click();
    await page.waitForFunction(() => !!(window as Record<string, unknown>).__logger);
    await page.evaluate(() => {
      const Logger = (window as Record<string, unknown>).__logger as {
        info(s: string, e: string, m: string, d?: unknown): void;
      };
      Logger.info('PC1', 'arp:request', 'who-has 192.168.1.2', { srcMac: 'aa:bb:cc:dd:ee:ff' });
      Logger.info('PC2', 'arp:reply',   'is-at aa:bb:cc:dd:ee:ff');
    });

    const dlJsonPromise = page.waitForEvent('download');
    await page.locator('[data-testid="logs-export-json"]').click();
    const dlJson = await dlJsonPromise;
    expect(dlJson.suggestedFilename()).toMatch(/^network-logs-\d+\.json$/);

    const dlCsvPromise = page.waitForEvent('download');
    await page.locator('[data-testid="logs-export-csv"]').click();
    const dlCsv = await dlCsvPromise;
    expect(dlCsv.suggestedFilename()).toMatch(/^network-logs-\d+\.csv$/);
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
