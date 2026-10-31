import { test, expect, type Page } from '@playwright/test';
import { buildSshLab, waitForStore, openTerminal, typeCommand, typePassword, termText, sshLogin } from './helpers/sshLab';

const liveInput = (page: Page) => page.locator('[data-testid="terminal-modal"] input[name="terminalInput"], [data-testid="terminal-modal"] input[name="terminalPrompt"]');

async function streamThenInterrupt(page: Page, command: string, promptPattern: RegExp, minReplies: number): Promise<void> {
  await typeCommand(page, command);
  await expect.poll(async () => (await termText(page)).split('\n').filter((l) => /bytes[ =]/.test(l)).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(minReplies);
  await expect(liveInput(page)).toHaveCount(0);

  await page.locator('[data-testid="terminal-modal"]').click();
  await page.keyboard.press('Control+c');
  await expect(liveInput(page)).toHaveCount(1);
  const text = await termText(page);
  expect(text).toContain('^C');
  const tail = text.trimEnd().split('\n').slice(-3);
  const prompts = tail.filter((l) => promptPattern.test(l.trim()));
  expect(prompts).toHaveLength(1);
}

test.describe('a foreground command behaves the same from every terminal', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('local Linux ping', async ({ page }) => {
    const lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
    await streamThenInterrupt(page, 'ping 10.0.0.2', /^user@PC1:~\$$/, 3);
  });

  test('Linux -> SSH -> Linux ping', async ({ page }) => {
    const lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
    await sshLogin(page, lab.ip.linux2, 'user', 'admin');
    await streamThenInterrupt(page, 'ping 10.0.0.1', /^user@PC2:~\$$/, 3);
  });

  test('Windows -> SSH -> Linux ping', async ({ page }) => {
    const lab = await buildSshLab(page);
    await openTerminal(page, lab.win1);
    await sshLogin(page, lab.ip.linux1, 'user', 'admin');
    await streamThenInterrupt(page, 'ping 10.0.0.2', /^user@PC1:~\$$/, 3);
  });

  test('Cisco IOS -> SSH -> Linux ping', async ({ page }) => {
    const lab = await buildSshLab(page);
    await page.evaluate(async (id) => {
      const store = (window as unknown as { __networkStore: { getState(): { deviceInstances: Map<string, { executeCommand(c: string): Promise<string> }> } } }).__networkStore;
      const device = store.getState().deviceInstances.get(id)!;
      await device.executeCommand("sudo sh -c 'printf \"KexAlgorithms +diffie-hellman-group14-sha1\\nHostKeyAlgorithms +ssh-rsa\\n\" >> /etc/ssh/sshd_config'");
      await device.executeCommand('sudo systemctl reload ssh');
    }, lab.linux1);
    await openTerminal(page, lab.ciscoR1);
    await typeCommand(page, 'ssh -l user 10.0.0.1');
    await typePassword(page, 'admin');
    await expect.poll(() => termText(page)).toContain('user@PC1');
    await streamThenInterrupt(page, 'ping 10.0.0.2', /^user@PC1:~\$$/, 3);
  });

  test('Linux -> SSH -> Windows ping -t keeps going until Ctrl+C', async ({ page }) => {
    const lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
    await sshLogin(page, lab.ip.win1, 'carl', 'carl');
    await streamThenInterrupt(page, 'ping -t 10.0.0.1', /^C:\\Users\\carl>$/, 6);
    await typeCommand(page, 'echo apres');
    await expect.poll(() => termText(page)).toMatch(/\napres/);
  });
});
