import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 45_000 });
}

async function lan(page: Page, gaucheType: string): Promise<{ gauche: string; droite: string }> {
  return page.evaluate(({ gaucheType }) => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const gauche = store.getState().addDevice(gaucheType, 300, 260);
    const droite = store.getState().addDevice('linux-pc', 620, 260);
    store.getState().addConnection(gauche.id, 'eth0', droite.id, 'eth0', 'ethernet');
    return { gauche: gauche.id, droite: droite.id };
  }, { gaucheType });
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
    await page.waitForTimeout(400);
  }
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

test.describe('netstat -s rend ce que la machine a compte', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('Linux lit ses compteurs dans /proc/net/snmp', async ({ page }) => {
    test.slow();
    const { gauche, droite } = await lan(page, 'linux-pc');

    await openTerminal(page, droite);
    await typeCmd(page, 'sudo ip addr add 10.0.0.2/24 dev eth0');
    await answerSudoPrompt(page);
    await typeCmd(page, 'sudo ip link set eth0 up');
    await answerSudoPrompt(page);
    await closeTerminal(page);

    await openTerminal(page, gauche);
    await typeCmd(page, 'sudo ip addr add 10.0.0.1/24 dev eth0');
    await answerSudoPrompt(page);
    await typeCmd(page, 'sudo ip link set eth0 up');
    await answerSudoPrompt(page);
    await typeCmd(page, 'ping -c 3 10.0.0.2');
    await page.waitForTimeout(1200);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'netstat -s | head -8');
    const s = await modalText(page);
    expect(s).toMatch(/3 total packets received/);
    expect(s).toMatch(/3 requests sent out/);

    await typeCmd(page, 'clear');
    await typeCmd(page, 'grep "^Icmp: 3" /proc/net/snmp');
    expect(await modalText(page)).toMatch(/proc\/net\/snmp\s*\n\s*Icmp: 3 0 0 0 0 0 0 0 0 3 /);

    await closeTerminal(page);
  });

  test('Windows rend les quatre blocs, pas la table des connexions', async ({ page }) => {
    test.slow();
    const { gauche, droite } = await lan(page, 'windows-pc');

    await openTerminal(page, droite);
    await typeCmd(page, 'sudo ip addr add 10.0.0.2/24 dev eth0');
    await answerSudoPrompt(page);
    await typeCmd(page, 'sudo ip link set eth0 up');
    await answerSudoPrompt(page);
    await closeTerminal(page);

    await openTerminal(page, gauche);
    await typeCmd(page, 'netsh interface ip set address "Ethernet 0" static 10.0.0.1 255.255.255.0');
    await typeCmd(page, 'ping -n 3 10.0.0.2');
    await page.waitForTimeout(1200);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'netstat -s -p icmp');
    const icmp = await modalText(page);
    expect(icmp).toContain('ICMPv4 Statistics');
    expect(icmp).not.toContain('Active Connections');
    expect(icmp).toMatch(/Echos\s+0\s+3/);
    expect(icmp).toMatch(/Echo Replies\s+3\s+0/);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'netstat -s -p ip');
    const ip = await modalText(page);
    expect(ip).toContain('IPv4 Statistics');
    expect(ip).toMatch(/Packets Received\s+= 3/);
    expect(ip).toMatch(/Output Requests\s+= 3/);

    await closeTerminal(page);
  });
});
