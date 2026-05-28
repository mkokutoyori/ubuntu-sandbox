/**
 * Reproduces the "first drag fails, retries succeed" symptom the user
 * reports on a freshly-loaded page. Drives HTML5 DnD via the native
 * dragstart / dragover / drop events (this is what the real browser
 * fires for a draggable=true element — `mouse.down/up` alone does not
 * trigger HTML5 DnD in Chromium without dispatchEvent).
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForPalette(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
  await expect(page.locator('h2').filter({ hasText: 'Equipment' })).toBeVisible({ timeout: 5_000 });
}

async function deviceCount(page: Page): Promise<number> {
  return page.locator('[data-device-id]').count();
}

/**
 * Fire a native HTML5 DnD sequence. Uses a shared DataTransfer instance
 * across dragstart → dragover → drop so the dropped payload is the
 * same one that was set on dragstart, matching real browser semantics.
 */
async function html5Drag(
  page: Page,
  sourceSelector: string,
  targetSelector: string,
  clientX: number,
  clientY: number,
): Promise<void> {
  await page.evaluate(
    ({ sourceSelector, targetSelector, clientX, clientY }) => {
      const source = document.querySelector(sourceSelector) as HTMLElement | null;
      const target = document.querySelector(targetSelector) as HTMLElement | null;
      if (!source || !target) throw new Error('drag source or target not found');
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { sourceSelector, targetSelector, clientX, clientY },
  );
}

test.describe('drag-and-drop first-attempt regression', () => {
  test('first HTML5 drag should place a device on the canvas', async ({ page }) => {
    await page.goto('/');
    await waitForPalette(page);
    expect(await deviceCount(page)).toBe(0);

    const canvas = page.locator('#network-canvas');
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error('canvas not visible');
    const targetX = canvasBox.x + canvasBox.width / 2;
    const targetY = canvasBox.y + canvasBox.height / 2;

    await html5Drag(page, '[draggable="true"]', '#network-canvas', targetX, targetY);
    await page.waitForTimeout(200);
    const afterFirst = await deviceCount(page);
    console.log('after attempt 1:', afterFirst);

    await html5Drag(page, '[draggable="true"]', '#network-canvas', targetX + 80, targetY);
    await page.waitForTimeout(200);
    const afterSecond = await deviceCount(page);
    console.log('after attempt 2:', afterSecond);

    await html5Drag(page, '[draggable="true"]', '#network-canvas', targetX + 160, targetY);
    await page.waitForTimeout(200);
    const afterThird = await deviceCount(page);
    console.log('after attempt 3:', afterThird);

    await page.screenshot({ path: 'test-results/dnd-html5-after-three.png', fullPage: true });

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(2);
    expect(afterThird).toBe(3);
  });
});
