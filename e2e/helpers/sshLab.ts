import { expect, type Page } from '@playwright/test';

export interface SshLab {
  linux1: string;
  linux2: string;
  win1: string;
  ciscoR1: string;
  hwR1: string;
  sw: string;
  ip: Record<string, string>;
}

export async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

export async function buildSshLab(page: Page): Promise<SshLab> {
  return page.evaluate(async () => {
    type Dev = Record<string, unknown>;
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Dev>;
      addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };

    const add = (type: string, x: number, y: number) => store.getState().addDevice(type, x, y).id;
    const inst = (id: string) => store.getState().deviceInstances.get(id) as Dev;
    const exec = async (id: string, cmd: string) => {
      const d = inst(id);
      const fn = d.executeCommand as ((c: string) => Promise<string> | string) | undefined;
      if (fn) return Promise.resolve(fn.call(d, cmd));
      return '';
    };
    const ethPort = (id: string) => {
      const names = (inst(id).getPortNames as () => string[])();
      return names.find(n => n.startsWith('eth')) ?? names[0];
    };
    const firstPort = (id: string) => (inst(id).getPortNames as () => string[])()[0];

    const sw = add('switch-generic', 450, 80);
    const linux1 = add('linux-pc', 120, 260);
    const linux2 = add('linux-pc', 320, 260);
    const win1 = add('windows-pc', 520, 260);
    const ciscoR1 = add('router-cisco', 720, 260);
    const hwR1 = add('router-huawei', 900, 260);

    await exec(linux1, `sudo ip addr add 10.0.0.1/24 dev ${ethPort(linux1)}`);
    await exec(linux2, `sudo ip addr add 10.0.0.2/24 dev ${ethPort(linux2)}`);
    await exec(win1, `netsh interface ip set address name="${ethPort(win1)}" static 10.0.0.4 255.255.255.0`);

    await exec(ciscoR1, 'enable');
    await exec(ciscoR1, 'configure terminal');
    await exec(ciscoR1, 'hostname ciscoR1');
    await exec(ciscoR1, 'interface GigabitEthernet0/0');
    await exec(ciscoR1, 'ip address 10.0.0.6 255.255.255.0');
    await exec(ciscoR1, 'no shutdown');
    await exec(ciscoR1, 'exit');
    await exec(ciscoR1, 'username admin privilege 15 secret Admin@123');
    await exec(ciscoR1, 'enable secret Admin@123');
    await exec(ciscoR1, 'ip domain-name lab.local');
    await exec(ciscoR1, 'crypto key generate rsa modulus 2048');
    await exec(ciscoR1, 'ip ssh version 2');
    await exec(ciscoR1, 'line vty 0 4');
    await exec(ciscoR1, 'login local');
    await exec(ciscoR1, 'transport input ssh');
    await exec(ciscoR1, 'end');

    await exec(hwR1, 'system-view');
    await exec(hwR1, 'sysname hwR1');
    await exec(hwR1, 'interface GigabitEthernet0/0/0');
    await exec(hwR1, 'ip address 10.0.0.8 255.255.255.0');
    await exec(hwR1, 'undo shutdown');
    await exec(hwR1, 'quit');
    await exec(hwR1, 'aaa');
    await exec(hwR1, 'local-user admin password cipher Admin@123');
    await exec(hwR1, 'local-user admin service-type ssh');
    await exec(hwR1, 'local-user admin privilege level 15');
    await exec(hwR1, 'quit');
    await exec(hwR1, 'rsa local-key-pair create');
    await exec(hwR1, 'stelnet server enable');
    await exec(hwR1, 'user-interface vty 0 4');
    await exec(hwR1, 'authentication-mode aaa');
    await exec(hwR1, 'protocol inbound ssh');
    await exec(hwR1, 'quit');
    await exec(hwR1, 'ssh user admin authentication-type password');
    await exec(hwR1, 'ssh user admin service-type stelnet');
    await exec(hwR1, 'quit');

    const ports = store.getState();
    const devs = [linux1, linux2, win1, ciscoR1, hwR1];
    devs.forEach((id, i) => {
      const dport = id === win1 || id === linux1 || id === linux2 ? ethPort(id) : firstPort(id);
      ports.addConnection(id, dport, sw, (inst(sw).getPortNames as () => string[])()[i], 'ethernet');
    });

    return {
      linux1, linux2, win1, ciscoR1, hwR1, sw,
      ip: { linux1: '10.0.0.1', linux2: '10.0.0.2', win1: '10.0.0.4', ciscoR1: '10.0.0.6', hwR1: '10.0.0.8' },
    };
  });
}

export async function openTerminal(page: Page, deviceId: string): Promise<void> {
  await page.locator(`[data-device-id="${deviceId}"]`).first().dblclick({ timeout: 5_000 });
  await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible({ timeout: 8_000 });
}

export function termText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

export async function typeCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
}

export async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
}

export function inTerminal(page: Page, text: string) {
  return page.locator('[data-testid="terminal-modal"]').getByText(text, { exact: false });
}

export async function runAndCapture(page: Page, command: string, settleMs = 400): Promise<string> {
  const before = (await termText(page)).length;
  await typeCommand(page, command);
  await page.waitForTimeout(settleMs);
  return (await termText(page)).slice(before);
}

export interface SshTarget {
  ip: string;
  user: string;
  pass: string;
  prompt: RegExp;
  label: string;
}

export const TARGETS: Record<'linux2' | 'win1' | 'ciscoR1' | 'hwR1', SshTarget> = {
  linux2: { ip: '10.0.0.2', user: 'user', pass: 'admin', prompt: /user@PC\d:~\$/, label: 'Linux' },
  win1: { ip: '10.0.0.4', user: 'carl', pass: 'carl', prompt: /C:\\Users\\carl>/, label: 'Windows' },
  ciscoR1: { ip: '10.0.0.6', user: 'admin', pass: 'Admin@123', prompt: /ciscoR1#/, label: 'Cisco' },
  hwR1: { ip: '10.0.0.8', user: 'admin', pass: 'Admin@123', prompt: /<hwR1>/, label: 'Huawei' },
};

export async function sshLogin(page: Page, target: string, user: string, pass: string, settleMs = 800): Promise<string> {
  const before = (await termText(page)).length;
  await typeCommand(page, `ssh ${user}@${target}`);
  const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await expect(pw).toBeVisible({ timeout: 9_000 });
  await typePassword(page, pass);
  await page.waitForTimeout(settleMs);
  return (await termText(page)).slice(before);
}

export async function sshHop(page: Page, sshCmd: string, pass: string, settleMs = 1000): Promise<string> {
  const before = (await termText(page)).length;
  await typeCommand(page, sshCmd);
  const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  try {
    await expect(pw).toBeVisible({ timeout: 7_000 });
    await typePassword(page, pass);
  } catch {
    void 0;
  }
  await page.waitForTimeout(settleMs);
  return (await termText(page)).slice(before);
}
