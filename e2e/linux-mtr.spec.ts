import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
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
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string | RegExp, timeout = 8_000): Promise<void> {
  await expect.poll(
    async () => {
      const t = await modalText(page);
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
    },
    { timeout },
  ).toBe(true);
}

async function ctrlC(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').click();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(400);
}

async function promptInputVisible(page: Page): Promise<boolean> {
  const inputs = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
  for (const inp of inputs) {
    const box = await inp.boundingBox();
    if (box && box.width > 1 && box.height > 1) return true;
  }
  return false;
}

interface Lab { pc1: string; pc2: string }

async function buildLab(page: Page): Promise<Lab> {
  return page.evaluate(async () => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const pc1 = store.getState().addDevice('linux-pc', 200, 250);
    const pc2 = store.getState().addDevice('linux-pc', 600, 250);
    const i1 = store.getState().deviceInstances.get(pc1.id) as Record<string, unknown>;
    const i2 = store.getState().deviceInstances.get(pc2.id) as Record<string, unknown>;
    const exec = async (dev: Record<string, unknown>, c: string): Promise<void> => {
      const e = dev.executeCommand as (c: string) => Promise<string> | string;
      await Promise.resolve(e.call(dev, c));
    };
    store.getState().addConnection(pc1.id, 'eth0', pc2.id, 'eth0', 'ethernet');
    await exec(i1, 'ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await exec(i2, 'ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    // Warm both ARP caches so sync ping probes don't queue.
    await exec(i1, 'ping -c 1 10.0.0.2');
    await exec(i2, 'ping -c 1 10.0.0.1');
    return { pc1: pc1.id, pc2: pc2.id };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Linux — mtr through the real UI', () => {
  test('mtr --version prints the version banner', async ({ page }) => {
    const { pc1 } = await buildLab(page);
    await openTerminal(page, pc1);
    await typeCmd(page, 'mtr --version');
    await waitForText(page, 'mtr 0.95');
  });

  test('mtr -r -c 1 prints a report then unlocks the prompt', async ({ page }) => {
    const { pc1 } = await buildLab(page);
    await openTerminal(page, pc1);
    await typeCmd(page, 'mtr -r -c 1 10.0.0.2');
    await waitForText(page, 'Start:', 6_000);
    await waitForText(page, /\(10\.0\.0\.2\)/);
    await waitForText(page, /Loss%/);
    await waitForText(page, / 1\. 10\.0\.0\.2/);
    await expect.poll(async () => promptInputVisible(page), { timeout: 5_000 }).toBe(true);
  });

  test('mtr (live) keeps the prompt locked, repaints, and unlocks on Ctrl+C', async ({ page }) => {
    const { pc1 } = await buildLab(page);
    await openTerminal(page, pc1);
    await typeCmd(page, 'mtr -i 0.3 10.0.0.2');
    await waitForText(page, 'mtr 0.95', 6_000);
    expect(await promptInputVisible(page)).toBe(false);

    // Wait for at least 2 probes recorded → Snt column ≥ 2.
    await expect.poll(
      async () => {
        const t = await modalText(page);
        const m = t.match(/ 1\. 10\.0\.0\.2\s+\S+\s+(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
      },
      { timeout: 6_000 },
    ).toBeGreaterThanOrEqual(2);

    await ctrlC(page);
    await waitForText(page, '^C');
    expect(await promptInputVisible(page)).toBe(true);
  });
});
