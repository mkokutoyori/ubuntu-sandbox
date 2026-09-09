import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 45_000 });
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
  await page.waitForTimeout(400);
}

async function answerSudoPrompt(page: Page): Promise<void> {
  const mdp = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  if (await mdp.count() > 0) {
    await mdp.first().focus();
    await mdp.first().fill('admin');
    await mdp.first().press('Enter');
    await page.waitForTimeout(500);
  }
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('dmesg raconte le demarrage de cette machine', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('la premiere ligne du tampon est /proc/version', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'sudo dmesg | head -1');
    await answerSudoPrompt(page);
    const banniere = await modalText(page);
    expect(banniere).toMatch(/\[\s*0\.000000\] Linux version 5\.15\.0-130-generic \(buildd@lcy02-amd64-001\)/);
    expect(banniere).toContain('#140-Ubuntu SMP');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /proc/version');
    expect(await modalText(page)).toContain('buildd@lcy02-amd64-001');

    await closeTerminal(page);
  });

  test('le processeur, la memoire et le chassis sont ceux de la machine', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'sudo dmesg | grep -E "CPU0:|DMI:|Memory:"');
    await answerSudoPrompt(page);
    const materiel = await modalText(page);
    expect(materiel).toContain('Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz');
    expect(materiel).toContain('QEMU Standard PC (i440FX + PIIX, 1996), BIOS 1.16.0-1 04/01/2014');
    expect(materiel).toMatch(/Memory: \d+K\/4194304K available/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /proc/cmdline');
    expect(await modalText(page)).toContain('BOOT_IMAGE=/vmlinuz-5.15.0-130-generic root=/dev/sda1');

    await closeTerminal(page);
  });
});
