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

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('systemctl repond a la question posee', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('--state=running rend les services qui tournent', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'systemctl list-units --type=service --state=running | grep -c running');
    expect(await modalText(page)).toMatch(/grep -c running\s*\n\s*(1[0-9]|[2-9][0-9])\b/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'systemctl list-units --type=service --state=running | grep -c dead');
    expect(await modalText(page)).toMatch(/grep -c dead\s*\n\s*0\b/);

    await closeTerminal(page);
  });

  test('sans --all, les unites mortes ne sont pas listees', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'systemctl list-units --type=service | grep -c dead');
    expect(await modalText(page)).toMatch(/grep -c dead\s*\n\s*0\b/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'systemctl list-units --type=service --all | grep -c dead');
    expect(await modalText(page)).toMatch(/grep -c dead\s*\n\s*[1-9]\d*\b/);

    await closeTerminal(page);
  });

  test('ss et systemctl status donnent le meme pid pour sshd', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'linux-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'ss -tlnp | grep :22');
    const parSs = /pid=(\d+)/.exec(await modalText(page))?.[1];
    expect(parSs).toBeTruthy();

    await typeCmd(page, 'clear');
    await typeCmd(page, 'systemctl status ssh | grep "Main PID"');
    expect(await modalText(page)).toContain(`Main PID: ${parSs} (sshd)`);

    await closeTerminal(page);
  });
});
