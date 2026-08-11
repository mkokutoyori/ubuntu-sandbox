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
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
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

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

interface Lab {
  routeur: string;
  collecteur: string;
}

async function buildLab(page: Page): Promise<Lab> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const routeur = store.getState().addDevice('router-cisco', 200, 250);
    const sw = store.getState().addDevice('switch-generic', 400, 250);
    const collecteur = store.getState().addDevice('linux-server', 620, 250);
    store.getState().addConnection(routeur.id, 'GigabitEthernet0/0', sw.id, 'eth0', 'ethernet');
    store.getState().addConnection(collecteur.id, 'eth0', sw.id, 'eth1', 'ethernet');

    for (const id of [routeur.id, sw.id, collecteur.id]) {
      const dev = store.getState().deviceInstances.get(id) as Record<string, unknown>;
      (dev.powerOn as (() => void) | undefined)?.call(dev);
    }
    const srv = store.getState().deviceInstances.get(collecteur.id) as Record<string, unknown>;
    const exec = srv.executeCommand as (c: string) => Promise<string>;
    return Promise.resolve()
      .then(() => exec.call(srv, 'ip addr add 192.168.100.50/24 dev eth0'))
      .then(() => ({ routeur: routeur.id, collecteur: collecteur.id }));
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Syslog — le collecteur central, depuis l\'interface', () => {
  test('rsyslog ouvre le 514, le routeur emet, le collecteur classe sous le nom de l\'emetteur', async ({ page }) => {
    test.setTimeout(90_000);
    const { routeur, collecteur } = await buildLab(page);

    await openTerminal(page, collecteur);
    await typeCmd(page, "sed -i 's/^#module(load=\"imudp\")/module(load=\"imudp\")/' /etc/rsyslog.conf");
    await typeCmd(page, "sed -i 's/^#input(type=\"imudp\" port=\"514\")/input(type=\"imudp\" port=\"514\")/' /etc/rsyslog.conf");
    await typeCmd(page, 'rsyslogd -N1');
    await waitForText(page, 'End of config validation run');
    await typeCmd(page, 'systemctl restart rsyslog');
    await typeCmd(page, 'ss -ulnp | grep 514');
    await waitForText(page, '514');
    await closeTerminal(page);

    await openTerminal(page, routeur);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
      'logging host 192.168.100.50', 'logging trap informational',
      'logging facility local7', 'hostname R1-PROD', 'end']) {
      await typeCmd(page, c);
    }
    await typeCmd(page, 'show logging');
    await waitForText(page, '192.168.100.50');
    await closeTerminal(page);

    await openTerminal(page, collecteur);
    await typeCmd(page, 'grep CONFIG_I /var/log/syslog');
    await waitForText(page, '%SYS-5-CONFIG_I');
    await waitForText(page, 'R1-PROD');
  });

  test('`/etc/logrotate.d/rsyslog` est livre, et `chattr +i` protege une archive', async ({ page }) => {
    const { collecteur } = await buildLab(page);

    await openTerminal(page, collecteur);
    await typeCmd(page, 'ls /etc/logrotate.d/');
    await waitForText(page, 'rsyslog');
    await typeCmd(page, 'cat /etc/logrotate.d/rsyslog');
    await waitForText(page, 'rotate 4');

    await typeCmd(page, 'echo archive > /var/log/syslog.1');
    await typeCmd(page, 'chattr +i /var/log/syslog.1');
    await typeCmd(page, 'lsattr /var/log/syslog.1');
    await waitForText(page, '----i');
    await typeCmd(page, 'echo falsifie > /var/log/syslog.1');
    await typeCmd(page, 'cat /var/log/syslog.1');
    await waitForText(page, 'archive');
  });
});
