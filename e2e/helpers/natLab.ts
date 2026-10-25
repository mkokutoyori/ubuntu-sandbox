import { type Page } from '@playwright/test';

export async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 30_000 });
}

export interface Ids { r: string; isp: string; win: string; lin: string; srv: string; ext: string; web2: string }

export async function buildLab(page: Page): Promise<Ids> {
  return page.evaluate(async () => {
    type Device = Record<string, unknown>;
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Device>;
      addConnection(srcId: string, srcIf: string, dstId: string, dstIf: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const add = (type: string, x: number, y: number): { id: string; device: Device } => {
      const dto = store.getState().addDevice(type, x, y);
      return { id: dto.id, device: store.getState().deviceInstances.get(dto.id) as Device };
    };
    const ports = (d: Device): string[] => (d.getPortNames as () => string[])();
    const run = async (d: Device, lines: string[]): Promise<void> => {
      for (const line of lines) await Promise.resolve((d.executeCommand as (c: string) => Promise<string>).call(d, line));
    };
    const lanSw = add('switch-generic', 400, 300);
    const ispSw = add('switch-generic', 900, 300);
    const r = add('router-cisco', 650, 300);
    const isp = add('router-cisco', 1100, 300);
    const win = add('windows-pc', 200, 100);
    const lin = add('linux-pc', 200, 300);
    const srv = add('linux-server', 200, 500);
    const ext = add('linux-server', 1100, 500);
    const sw2 = add('switch-cisco', 1100, 700);
    const web2 = add('linux-server', 900, 700);
    const link = (a: { id: string; device: Device }, ai: string, b: { id: string; device: Device }, bi: string): void => {
      store.getState().addConnection(a.id, ai, b.id, bi, 'ethernet');
    };
    const sw = (d: Device, i: number): string => ports(d)[i];
    link(win, ports(win.device)[0], lanSw, sw(lanSw.device, 0));
    link(lin, ports(lin.device)[0], lanSw, sw(lanSw.device, 1));
    link(srv, ports(srv.device)[0], lanSw, sw(lanSw.device, 2));
    link(r, 'GigabitEthernet0/0', lanSw, sw(lanSw.device, 7));
    link(r, 'GigabitEthernet0/1', ispSw, sw(ispSw.device, 0));
    link(isp, 'GigabitEthernet0/0', ispSw, sw(ispSw.device, 1));
    link(ext, ports(ext.device)[0], ispSw, sw(ispSw.device, 2));
    link(isp, 'GigabitEthernet0/1', sw2, sw(sw2.device, 0));
    link(web2, ports(web2.device)[0], sw2, sw(sw2.device, 1));
    const eth = (d: Device): string => ports(d)[0];
    await run(lin.device, [`sudo ip addr add 192.168.10.22/24 dev ${eth(lin.device)}`, `sudo ip route add default via 192.168.10.1`]);
    await run(srv.device, [`sudo ip addr add 192.168.10.10/24 dev ${eth(srv.device)}`, `sudo ip route add default via 192.168.10.1`, 'systemctl start nginx']);
    await run(ext.device, [`sudo ip addr add 203.0.113.9/28 dev ${eth(ext.device)}`, `sudo ip route add default via 203.0.113.2`, 'systemctl start nginx']);
    await run(r.device, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 203.0.113.2 255.255.255.240', 'no shutdown', 'exit',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end',
      'configure terminal', 'interface GigabitEthernet0/0', 'ip nat inside', 'exit', 'interface GigabitEthernet0/1', 'ip nat outside', 'exit',
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload', 'ip nat inside source static 192.168.10.10 203.0.113.3', 'end',
    ]);
    await run(isp.device, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 203.0.113.1 255.255.255.240', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 170.20.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 170.20.0.1', 'ip dhcp pool WEB', 'network 170.20.0.0 255.255.255.0', 'exit', 'end',
    ]);
    await run(web2.device, ['sudo dhclient eth0', 'systemctl start nginx']);
    return { r: r.id, isp: isp.id, win: win.id, lin: lin.id, srv: srv.id, ext: ext.id, web2: web2.id };
  });
}

export async function openTerminal(page: Page, deviceId: string): Promise<void> {
  const peek = page.locator('button[title="Show topology (terminals stay open)"]');
  if (await peek.isVisible().catch(() => false)) await peek.click();
  await page.locator(`[data-device-id="${deviceId}"]`).first().dblclick({ timeout: 10_000 });
  await page.waitForTimeout(400);
}

export async function typeIn(page: Page, deviceId: string, command: string): Promise<void> {
  const modal = page.locator(`[data-testid="terminal-modal"][data-device-id="${deviceId}"]`);
  const input = modal.locator('input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
}

export async function lineCount(page: Page, deviceId: string, text: string): Promise<number> {
  return page.locator(`[data-testid="terminal-modal"][data-device-id="${deviceId}"]`).getByText(text, { exact: true }).count().catch(() => 0);
}
