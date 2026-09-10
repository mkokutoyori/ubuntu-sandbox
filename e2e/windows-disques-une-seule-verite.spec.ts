import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('les vues du stockage Windows decrivent LA meme machine', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('Get-Disk, Get-Partition et wmic diskdrive s accordent', async ({ page }) => {
    const pc = await addDevice(page, 'windows-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'powershell Get-Disk');
    const disques = await modalText(page);
    expect(disques.split('\n').filter((l) => /^\s*\d\s+(Virtual|Microsoft)/.test(l)).length).toBe(2);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'powershell Get-Partition -DiskNumber 0');
    const partitions = await modalText(page);
    expect(partitions).toContain('Disk Number: 0');
    expect(partitions).toMatch(/^\s*2\s+C\s+\d+/m);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'wmic diskdrive get deviceid,model');
    expect(await modalText(page)).toContain('\\\\.\\PHYSICALDRIVE0');

    await closeTerminal(page);
  });

  test('fsutil compte la meme place libre que dir', async ({ page }) => {
    const pc = await addDevice(page, 'windows-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'fsutil volume diskfree C:');
    const sortie = await modalText(page);
    expect(sortie).toMatch(/Total # of free bytes\s+: \d+ \(\d+\.\d{2}GB\)/);
    const parFsutil = /Total # of free bytes\s+: (\d+)/.exec(sortie)?.[1] ?? '<fsutil>';

    await typeCmd(page, 'cls');
    await typeCmd(page, 'dir C:\\');
    const parDir = /([\d,]+) bytes free/.exec(await modalText(page))?.[1].replace(/,/g, '') ?? '<dir>';

    expect(parFsutil).toBe(parDir);

    await closeTerminal(page);
  });
});
