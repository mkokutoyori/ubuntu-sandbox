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

async function visibleTextInputs(page: Page): Promise<number> {
  return page.locator('[data-testid="terminal-modal"] input[type="text"]:visible').count();
}

async function setupWinLinuxLan(page: Page): Promise<{ win: string; linux: string }> {
  return page.evaluate(async () => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const win = store.getState().addDevice('windows-pc', 250, 250);
    const linux = store.getState().addDevice('linux-pc', 600, 250);
    const sw = store.getState().addDevice('switch-cisco', 425, 400);
    const wi = store.getState().deviceInstances.get(win.id) as Record<string, unknown>;
    const li = store.getState().deviceInstances.get(linux.id) as Record<string, unknown>;
    const exec = async (dev: Record<string, unknown>, c: string): Promise<void> => {
      const e = dev.executeCommand as ((c: string) => Promise<string> | string) | undefined;
      if (e) await Promise.resolve(e.call(dev, c));
    };
    await exec(wi, 'netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
    await exec(li, 'ifconfig eth0 192.168.1.20');
    store.getState().addConnection(win.id, 'eth0', sw.id, 'FastEthernet0/1', 'ethernet');
    store.getState().addConnection(linux.id, 'eth0', sw.id, 'FastEthernet0/2', 'ethernet');
    return { win: win.id, linux: linux.id };
  });
}

async function enterPowerShell(page: Page): Promise<void> {
  await typeCmd(page, 'powershell');
  await page.waitForTimeout(500);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Windows — PS Get-Content -Wait through the real UI', () => {
  test('streams existing content then appended bytes; Ctrl+C unlocks the prompt', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await page.evaluate(({ id }) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
      const dev = store.getState().deviceInstances.get(id) as { getFileSystem(): { createFile(p: string, c: string): unknown } };
      dev.getFileSystem().createFile('C:\\probe.log', 'first\nsecond\n');
    }, { id });

    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'Get-Content C:\\probe.log -Wait');

    await waitForText(page, 'first');
    await waitForText(page, 'second');
    const inputs = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
    let promptInputVisible = false;
    for (const inp of inputs) {
      const box = await inp.boundingBox();
      if (box && box.width > 1 && box.height > 1) promptInputVisible = true;
    }
    expect(promptInputVisible).toBe(false);

    await page.evaluate(({ id }) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
      const dev = store.getState().deviceInstances.get(id) as { getFileSystem(): { appendFile(p: string, c: string): unknown } };
      dev.getFileSystem().appendFile('C:\\probe.log', 'live-appended\n');
    }, { id });

    await waitForText(page, 'live-appended', 5_000);

    await ctrlC(page);
    await waitForText(page, '^C');
    await page.waitForTimeout(300);
    const restored = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
    let promptBack = false;
    for (const inp of restored) {
      const box = await inp.boundingBox();
      if (box && box.width > 1 && box.height > 1) promptBack = true;
    }
    expect(promptBack).toBe(true);
  });
});

test.describe('Windows — PS Test-Connection -Continuous through the real UI', () => {
  test('streams reply rows until Ctrl+C, prompt locked while running', async ({ page }) => {
    const { win } = await setupWinLinuxLan(page);
    await openTerminal(page, win);
    await enterPowerShell(page);
    await typeCmd(page, 'Test-Connection 192.168.1.20 -Continuous -Delay 1');

    await waitForText(page, /Source\s+Destination/);
    // While a foreground async stream holds the tty, the normal prompt
    // input is hidden — only the opacity-0 capture input remains.
    const inputs = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
    let promptInputVisible = false;
    for (const inp of inputs) {
      const box = await inp.boundingBox();
      if (box && box.width > 1 && box.height > 1) promptInputVisible = true;
    }
    expect(promptInputVisible).toBe(false);

    await waitForText(page, '192.168.1.20', 5_000);

    await ctrlC(page);
    await waitForText(page, '^C');
    await page.waitForTimeout(300);
    const restored = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
    let promptBack = false;
    for (const inp of restored) {
      const box = await inp.boundingBox();
      if (box && box.width > 1 && box.height > 1) promptBack = true;
    }
    expect(promptBack).toBe(true);
  });

  test('-Count 0 also streams; TimedOut shown on unreachable host', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await enterPowerShell(page);
    await typeCmd(page, 'Test-Connection 192.168.99.99 -Count 0 -Delay 1');

    await waitForText(page, /Source\s+Destination/);
    await waitForText(page, 'TimedOut', 5_000);

    await ctrlC(page);
    await waitForText(page, '^C');
  });
});

test.describe('Windows — cmd netstat <interval> through the real UI', () => {
  test('reprints the Active Connections table each interval; Ctrl+C cancels', async ({ page }) => {
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
    await typeCmd(page, 'netstat -an 1');

    await waitForText(page, 'Active Connections');
    const inputs = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
    let promptInputVisible = false;
    for (const inp of inputs) {
      const box = await inp.boundingBox();
      if (box && box.width > 1 && box.height > 1) promptInputVisible = true;
    }
    expect(promptInputVisible).toBe(false);

    await expect.poll(
      async () => (await modalText(page)).split('Active Connections').length - 1,
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(2);

    await ctrlC(page);
    await waitForText(page, '^C');
    await page.waitForTimeout(300);
    const restored = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
    let promptBack = false;
    for (const inp of restored) {
      const box = await inp.boundingBox();
      if (box && box.width > 1 && box.height > 1) promptBack = true;
    }
    expect(promptBack).toBe(true);
  });
});

test.describe('Windows — PS Test-NetConnection through the real UI', () => {
  test('reachable host: PingSucceeded True with real source / interface', async ({ page }) => {
    const { win } = await setupWinLinuxLan(page);
    await openTerminal(page, win);
    await enterPowerShell(page);
    await typeCmd(page, 'Test-NetConnection 192.168.1.20');
    await waitForText(page, /PingSucceeded\s*:\s*True/);
    const text = await modalText(page);
    expect(text).toMatch(/SourceAddress\s*:\s*192\.168\.1\.10/);
    expect(text).toMatch(/InterfaceAlias\s*:\s*eth0/);
  });

  test('closed port: TcpTestSucceeded False', async ({ page }) => {
    const { win } = await setupWinLinuxLan(page);
    await openTerminal(page, win);
    await enterPowerShell(page);
    await typeCmd(page, 'Test-NetConnection 192.168.1.20 -Port 12345');
    await waitForText(page, /TcpTestSucceeded\s*:\s*False/);
  });
});

test.describe('Windows — cmd pathping through the real UI', () => {
  test('discovery + statistics + trailer', async ({ page }) => {
    const { win } = await setupWinLinuxLan(page);
    await openTerminal(page, win);
    await typeCmd(page, 'pathping -q 2 -p 30 -w 500 -h 5 192.168.1.20');
    await waitForText(page, 'Tracing route to');
    await waitForText(page, /Computing statistics for \d+ seconds/);
    await waitForText(page, 'Trace complete.', 15_000);
  });
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });
