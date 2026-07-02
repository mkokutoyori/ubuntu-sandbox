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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Linux — vmstat <interval> through the real UI', () => {
  test('one-shot prints procps-ng header + one data row', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'vmstat');
    await waitForText(page, / r  b   swpd   free   buff  cache/);
    const text = await modalText(page);
    expect(text).toMatch(/procs -+memory-+/);
  });

  test('vmstat 1 streams rows; header printed once; Ctrl+C unlocks the prompt', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'vmstat 1');
    await waitForText(page, / r  b   swpd   free   buff  cache/);
    expect(await promptInputVisible(page)).toBe(false);

    await expect.poll(
      async () => {
        const lines = (await modalText(page)).split('\n');
        return lines.filter((l) => /^\s*\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/.test(l)).length;
      },
      { timeout: 6_000 },
    ).toBeGreaterThanOrEqual(2);
    const headerCount = (await modalText(page)).split('\n').filter((l) => / r  b   swpd/.test(l)).length;
    expect(headerCount).toBe(1);

    await ctrlC(page);
    await waitForText(page, '^C');
    expect(await promptInputVisible(page)).toBe(true);
  });

  test('vmstat 1 2 exits on its own after 2 rows', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'vmstat 1 2');
    await expect.poll(
      async () => (await modalText(page)).split('\n').filter((l) => /^\s*\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/.test(l)).length,
      { timeout: 6_000 },
    ).toBe(2);
    await expect.poll(async () => promptInputVisible(page), { timeout: 5_000 }).toBe(true);
  });
});

test.describe('Linux — mpstat <interval> through the real UI', () => {
  test('one-shot prints sysstat banner + column header + all CPU row', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'mpstat');
    await waitForText(page, /Linux \S+ \(.+\)\s+\d{2}\/\d{2}\/\d{4}\s+_\S+_\s+\(\d+ CPU\)/);
    await waitForText(page, /CPU\s+%usr\s+%nice\s+%sys/);
  });

  test('mpstat 1 streams rows; Average trailer appears on Ctrl+C', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'mpstat 1');
    await waitForText(page, /CPU\s+%usr\s+%nice\s+%sys/);
    expect(await promptInputVisible(page)).toBe(false);

    await expect.poll(
      async () => (await modalText(page)).split('\n').filter((l) => /^\d\d:\d\d:\d\d (?:AM|PM)\s+all\s+\d+\.\d{2}/.test(l)).length,
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(1);

    await ctrlC(page);
    await waitForText(page, /^Average:\s+all\s+\d+\.\d{2}/m);
    expect(await promptInputVisible(page)).toBe(true);
  });

  test('mpstat 1 2 exits on its own after 2 rows + final Average', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'mpstat 1 2');
    await waitForText(page, /^Average:\s+all/m, 8_000);
    await expect.poll(async () => promptInputVisible(page), { timeout: 5_000 }).toBe(true);
  });
});

test.describe('Linux — pidstat <interval> through the real UI', () => {
  test('one-shot prints sysstat banner + CPU column header + at least one PID row', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'pidstat');
    await waitForText(page, /UID\s+PID\s+%usr %system\s+%guest\s+%wait\s+%CPU\s+CPU\s+Command/);
  });

  test('pidstat -r switches to memory columns', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'pidstat -r');
    await waitForText(page, /UID\s+PID\s+minflt\/s\s+majflt\/s\s+VSZ\s+RSS\s+%MEM\s+Command/);
  });

  test('pidstat 1 2 streams rows + final Average per PID', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'pidstat 1 2');
    await waitForText(page, /^Average:\s+\d+\s+\d+\s+\d+\.\d{2}/m, 8_000);
    await expect.poll(async () => promptInputVisible(page), { timeout: 5_000 }).toBe(true);
  });
});

test.describe('Linux — free -s N through the real UI', () => {
  test('plain free without -s is one-shot', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'free');
    await waitForText(page, /total\s+used\s+free\s+shared/);
    const text = await modalText(page);
    const memRows = text.split('\n').filter((l) => /^Mem:\s+\d+/.test(l)).length;
    expect(memRows).toBe(1);
  });

  test('free -s 1 reprints the table; Ctrl+C unlocks the prompt', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'free -s 1');
    await waitForText(page, /total\s+used\s+free/);
    expect(await promptInputVisible(page)).toBe(false);

    await expect.poll(
      async () => (await modalText(page)).split('\n').filter((l) => /^Mem:\s+\d+/.test(l)).length,
      { timeout: 6_000 },
    ).toBeGreaterThanOrEqual(2);

    await ctrlC(page);
    await waitForText(page, '^C');
    expect(await promptInputVisible(page)).toBe(true);
  });

  test('free -s 1 -c 2 exits on its own after 2 samples', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'free -s 1 -c 2');
    await expect.poll(
      async () => (await modalText(page)).split('\n').filter((l) => /^Mem:\s+\d+/.test(l)).length,
      { timeout: 6_000 },
    ).toBe(2);
    await expect.poll(async () => promptInputVisible(page), { timeout: 5_000 }).toBe(true);
  });
});

test.describe('Linux — dmesg -w through the real UI', () => {
  test('streams the initial ring buffer then a live kernel entry', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await page.evaluate(({ id }) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
      const dev = store.getState().deviceInstances.get(id) as { executor: { logMgr: { logKernel(tag: string, msg: string): void } } };
      dev.executor.logMgr.logKernel('kernel', 'probeDmesgInitialBOOT');
    }, { id });

    await openTerminal(page, id);
    await typeCmd(page, 'dmesg -w');
    await waitForText(page, 'probeDmesgInitialBOOT');
    expect(await promptInputVisible(page)).toBe(false);

    await page.evaluate(({ id }) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
      const dev = store.getState().deviceInstances.get(id) as { executor: { logMgr: { logKernel(tag: string, msg: string): void } } };
      dev.executor.logMgr.logKernel('kernel', 'probeDmesgLIVEevent');
    }, { id });

    await waitForText(page, 'probeDmesgLIVEevent', 4_000);

    await ctrlC(page);
    await waitForText(page, '^C');
    expect(await promptInputVisible(page)).toBe(true);
  });
});
