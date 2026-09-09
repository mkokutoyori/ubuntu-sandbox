import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x = 400, y = 300): Promise<string> {
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
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
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

/**
 * `sudo` challenges for the local account's password on a fresh machine.
 * The masked input is rendered off-viewport, so it is driven with
 * `focus()` — the pattern every password-prompt spec in this repo uses.
 */
async function answerSudoPrompt(page: Page): Promise<void> {
  const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  if (await pw.count() === 0) return;
  await pw.focus();
  await pw.fill('admin');
  await pw.press('Enter');
  await page.waitForTimeout(400);
}

test.describe('les vues du stockage decrivent LA meme machine', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('un poste n annonce pas de disque de donnees, et son fstab le confirme', async ({ page }) => {
    const pc = await addDevice(page, 'linux-pc', 320, 240);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'df -h');
    const df = await modalText(page);
    expect(df).not.toContain('/u01');
    expect(df).not.toContain('/dev/sdb1');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /etc/fstab');
    const fstab = await modalText(page);
    expect(fstab).toContain('# /etc/fstab: static file system information.');
    expect(fstab).toMatch(/UUID=\S+\s+\/\s+ext4\s+relatime,errors=remount-ro\s+0\s+1/);
    expect(fstab).not.toContain('/u01');

    await closeTerminal(page);
  });

  test('df, lsblk et blkid s accordent sur /boot', async ({ page }) => {
    const pc = await addDevice(page, 'linux-pc', 320, 240);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'lsblk');
    expect(await modalText(page)).toMatch(/sda2 .*2G .*\/boot/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'df -h /boot');
    expect(await modalText(page)).toMatch(/\/dev\/sda2 +2\.0G/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'sudo blkid');
    await answerSudoPrompt(page);
    const blkid = await modalText(page);
    const uuid = /\/dev\/sda1: UUID="([^"]+)"/.exec(blkid)?.[1] ?? '<aucun>';

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /etc/fstab');
    expect(await modalText(page)).toContain(`UUID=${uuid}`);

    await closeTerminal(page);
  });

  test('un serveur declare son /u01 dans les trois vues', async ({ page }) => {
    const srv = await addDevice(page, 'linux-server', 520, 240);
    await openTerminal(page, srv);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'df -h');
    expect(await modalText(page)).toMatch(/\/dev\/sdb1\s+\S+\s+\S+\s+\S+\s+\d+%\s+\/u01/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /proc/mounts');
    expect(await modalText(page)).toContain('/dev/sdb1 /u01 ');

    await typeCmd(page, 'clear');
    await typeCmd(page, 'cat /etc/fstab');
    expect(await modalText(page)).toMatch(/UUID=\S+\s+\/u01\s+ext4\s/);

    await closeTerminal(page);
  });
});
