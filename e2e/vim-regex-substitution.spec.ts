import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 2 (e2e) — Recherche et remplacement global avec expressions
 * régulières dans vim, pilotée depuis la vraie UI terminal.
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

const FILE_LINES = [
  '# Configuration reseau mandeng',
  'auto eth0',
  'iface eth0 inet static',
  '  address 192.168.1.100',
  '  netmask 255.255.255.0',
  '  gateway 192.168.1.1',
  '',
  'auto eth1',
  'iface eth1 inet static',
  '  address 192.168.1.101',
  '  netmask 255.255.255.0',
  '  gateway 192.168.1.1',
  '',
  'auto eth2',
  'iface eth2 inet dhcp',
  '',
  '# Ancien format commente',
  '#address 10.0.0.1',
  '#netmask 255.0.0.0',
];

async function seedFile(page: Page, path: string): Promise<void> {
  await typeCmd(page, `echo "${FILE_LINES[0]}" > ${path}`);
  for (const line of FILE_LINES.slice(1)) {
    await typeCmd(page, `echo "${line}" >> ${path}`);
  }
}

test.describe('Scénario 2 (e2e) — vim :%s et :g regex', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('progressive substitution sequence produces the expected final file', async ({ page }) => {
    await seedFile(page, '/tmp/interfaces-vim.txt');
    await typeCmd(page, 'vim /tmp/interfaces-vim.txt');
    await expect(page.getByText('interfaces-vim.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await exCmd(page, '%s/192.168.1/10.10.10/g');
    await exCmd(page, '%s/eth/ens/gc');
    await expect(page.getByText(/replace with ens \(y\/n\/a\/q\/l\)\?/)).toBeVisible();
    await page.keyboard.press('a');

    await exCmd(page, String.raw`%s/address \(10\.10\.10\.\)\([0-9]*\)/address \1\2 # ajoute/g`);
    await exCmd(page, '5,10s/static/manual/g');
    await exCmd(page, String.raw`g/gateway/s/10\.10\.10\.1/10.10.10.254/g`);
    await exCmd(page, 'g/^#/d');

    await exCmd(page, 'wq');

    await typeCmd(page, 'cat /tmp/interfaces-vim.txt');
    const fullTranscript = await modalText(page);
    const catOutput = fullTranscript.slice(fullTranscript.lastIndexOf('cat /tmp/interfaces-vim.txt'));
    expect(catOutput).toContain('auto ens0');
    expect(catOutput).toContain('iface ens0 inet static');
    expect(catOutput).toContain('  address 10.10.10.100 # ajoute');
    expect(catOutput).toContain('  gateway 10.10.10.254');
    expect(catOutput).toContain('iface ens1 inet manual');
    expect(catOutput).not.toContain('192.168.1');

    await typeCmd(page, "grep -c '^#' /tmp/interfaces-vim.txt || echo NO_COMMENTS");
    expect(await modalText(page)).toContain('NO_COMMENTS');
  });

  test('interactive confirm (c flag): n skips, y applies, prompt disappears when done', async ({ page }) => {
    await typeCmd(page, 'echo "eth0 up" > /tmp/confirm.txt');
    await typeCmd(page, 'echo "eth1 up" >> /tmp/confirm.txt');
    await typeCmd(page, 'vim /tmp/confirm.txt');
    await expect(page.getByText('confirm.txt', { exact: true })).toBeVisible({ timeout: 5_000 });

    await exCmd(page, '%s/eth/ens/gc');
    await expect(page.getByText(/replace with ens \(y\/n\/a\/q\/l\)\?/)).toBeVisible();
    await page.keyboard.press('n');
    await expect(page.getByText(/replace with ens \(y\/n\/a\/q\/l\)\?/)).toBeVisible();
    await page.keyboard.press('y');
    await expect(page.getByText(/replace with ens/)).not.toBeVisible();

    await exCmd(page, 'wq');
    await typeCmd(page, 'cat /tmp/confirm.txt');
    const transcript = await modalText(page);
    expect(transcript).toContain('eth0 up');
    expect(transcript).toContain('ens1 up');
  });
});
