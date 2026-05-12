import { test } from '@playwright/test';

test('debug terminal open', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 10000 });
  
  const id = await page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice('linux-pc', 400, 300).id;
  });
  
  await page.waitForTimeout(1500);
  
  // Check if the device element exists and its position
  const info = await page.locator(`[data-device-id="${id}"]`).first().evaluate(el => ({
    id: el.getAttribute('data-device-id'),
    rect: el.getBoundingClientRect(),
    visible: (el as HTMLElement).offsetParent !== null,
  }));
  console.log('Device info:', JSON.stringify(info));
  
  // Double-click
  await page.locator(`[data-device-id="${id}"]`).first().dblclick();
  await page.waitForTimeout(2000);
  
  // Check all data-testid elements  
  const testIds = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-testid]')).map(el => el.getAttribute('data-testid'));
  });
  console.log('All test IDs in DOM:', JSON.stringify(testIds));
  
  // Check for any fixed overlay (z-50)
  const fixed = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[class*="z-50"]'));
    return all.map(el => ({ classes: el.className.substring(0, 80), text: el.textContent?.substring(0, 50) }));
  });
  console.log('z-50 elements:', JSON.stringify(fixed));
  
  await page.screenshot({ path: '/tmp/debug_terminal.png', fullPage: true });
});
