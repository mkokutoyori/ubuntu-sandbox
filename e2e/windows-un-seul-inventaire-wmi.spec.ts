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

test.describe('WMI et systeminfo decrivent le meme chassis', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('le constructeur est le meme dans les trois vues', async ({ page }) => {
    const pc = await addDevice(page, 'windows-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'systeminfo');
    expect(await modalText(page)).toMatch(/System Manufacturer:\s+QEMU/);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'wmic computersystem get manufacturer,model');
    const parWmic = await modalText(page);
    expect(parWmic).toContain('QEMU');
    expect(parWmic).toContain('Standard PC');

    await typeCmd(page, 'cls');
    await typeCmd(page, 'powershell Get-CimInstance Win32_ComputerSystem');
    expect(await modalText(page)).toMatch(/Manufacturer\s*:\s*QEMU/);

    await closeTerminal(page);
  });

  test('un alias inconnu est refuse, et Win32_BIOS repond', async ({ page }) => {
    const pc = await addDevice(page, 'windows-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'wmic zorglub get name');
    expect(await modalText(page)).toContain('Alias not found!');

    await typeCmd(page, 'cls');
    await typeCmd(page, 'powershell Get-CimInstance Win32_BIOS');
    const bios = await modalText(page);
    expect(bios).not.toContain('Invalid class');
    expect(bios).toContain('SeaBIOS');

    await closeTerminal(page);
  });
});
