import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 9 (e2e) — Édition de fichiers de configuration système
 * (/etc/crontab, /etc/ssh/sshd_config) avec vim, pilotée depuis la vraie
 * UI terminal : élévation root via `sudo su -`, détection du filetype,
 * et validation via les outils natifs (`sshd -t -f %`).
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}
async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
}
async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}
async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function becomeRoot(page: Page): Promise<void> {
  await typeCmd(page, 'sudo su -');
  await typePassword(page, 'admin');
}
async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}
async function typeText(page: Page, text: string): Promise<void> {
  for (const ch of text) {
    await page.evaluate((c) => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: c, bubbles: true, cancelable: true }));
    }, ch);
  }
}
async function exCmd(page: Page, cmd: string): Promise<void> {
  await page.keyboard.press(':');
  await typeText(page, cmd);
  await page.keyboard.press('Enter');
}
function lastCommandOutput(transcript: string, command: string): string {
  return transcript.slice(transcript.lastIndexOf(command));
}

test.describe('Scénario 9 (e2e) — fichiers de configuration système', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await becomeRoot(page);
  });

  test('vim /etc/crontab: filetype detection, add a job, saved content survives', async ({ page }) => {
    await typeCmd(page, 'vim /etc/crontab');
    await expect(page.getByText('crontab', { exact: true })).toBeVisible({ timeout: 5_000 });

    await exCmd(page, 'set filetype?');
    await expect(page.getByText('filetype=crontab')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('G');
    await page.keyboard.press('o');
    await typeText(page, '*/5 * * * *\troot\t/usr/local/bin/healthcheck.sh');
    await page.keyboard.press('Escape');
    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /etc/crontab');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'cat /etc/crontab');
    expect(out).toContain('healthcheck.sh');
  });

  test('vim /etc/ssh/sshd_config: filetype detection, edit Port, validated by sshd -t -f %', async ({ page }) => {
    await typeCmd(page, 'vim /etc/ssh/sshd_config');
    await expect(page.getByText('sshd_config', { exact: true })).toBeVisible({ timeout: 5_000 });

    await exCmd(page, 'set filetype?');
    await expect(page.getByText('filetype=sshconfig')).toBeVisible({ timeout: 5_000 });

    await exCmd(page, '%s/^Port.*/Port 2222/');
    await exCmd(page, 'w');
    await exCmd(page, '!sshd -t -f %');
    // Valid config: sshd -t prints nothing, so vim's shell-output banner
    // stays empty — no `E`/error text ever appears on the command line.
    await expect(page.getByText(/Bad configuration option/)).not.toBeVisible();
    await exCmd(page, 'q');

    await typeCmd(page, 'sshd -t -f /etc/ssh/sshd_config; echo EXIT=$?');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'sshd -t -f /etc/ssh/sshd_config');
    expect(out).toContain('EXIT=0');
  });
});
