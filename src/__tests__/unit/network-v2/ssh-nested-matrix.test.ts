import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
function texts(s: TerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: TerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}
async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 6 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 6; i++) await tick();
}
function runOnForeground(host: TerminalSession, line: string): void {
  host.foreground.setInput(line);
  host.foreground.setInputBuf(line);
  host.handleKey(key('Enter'));
}

async function buildLab() {
  EquipmentRegistry.resetInstance();
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const linuxB = new LinuxPC('linux-pc', 'linuxB', 0, 0);
  const cisco = new CiscoRouter('R1', 0, 0);
  const huawei = new HuaweiRouter('hwR1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  [winA, winB, linuxA, linuxB, cisco, huawei].forEach((d) => d.powerOn());
  sw.powerOn();
  new Cable('c1').connect(winA.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(winB.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(linuxA.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  new Cable('c4').connect(linuxB.getPort('eth0')!, sw.getPort('FastEthernet0/4')!);
  new Cable('c5').connect(cisco.getPorts()[0], sw.getPort('FastEthernet0/5')!);
  new Cable('c6').connect(huawei.getPorts()[0], sw.getPort('FastEthernet0/6')!);
  await winA.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.1 255.255.255.0');
  await winB.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.2 255.255.255.0');
  await linuxA.executeCommand('ifconfig eth0 10.0.0.3');
  await linuxB.executeCommand('ifconfig eth0 10.0.0.4');
  await cisco.executeCommand('enable');
  await cisco.executeCommand('configure terminal');
  await cisco.executeCommand('hostname R1');
  await cisco.executeCommand('interface GigabitEthernet0/0');
  await cisco.executeCommand('ip address 10.0.0.5 255.255.255.0');
  await cisco.executeCommand('no shutdown');
  await cisco.executeCommand('exit');
  await cisco.executeCommand('username admin privilege 15 secret Admin@123');
  await cisco.executeCommand('enable secret Admin@123');
  await cisco.executeCommand('ip domain-name lab.local');
  await cisco.executeCommand('crypto key generate rsa modulus 2048');
  await cisco.executeCommand('ip ssh version 2');
  await cisco.executeCommand('line vty 0 4');
  await cisco.executeCommand('login local');
  await cisco.executeCommand('transport input ssh');
  await cisco.executeCommand('end');
  await huawei.executeCommand('system-view');
  await huawei.executeCommand('sysname hwR1');
  await huawei.executeCommand('interface GigabitEthernet0/0/0');
  await huawei.executeCommand('ip address 10.0.0.6 255.255.255.0');
  await huawei.executeCommand('undo shutdown');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('aaa');
  await huawei.executeCommand('local-user admin password cipher Admin@123');
  await huawei.executeCommand('local-user admin service-type ssh');
  await huawei.executeCommand('local-user admin privilege level 15');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('rsa local-key-pair create');
  await huawei.executeCommand('stelnet server enable');
  await huawei.executeCommand('user-interface vty 0 4');
  await huawei.executeCommand('authentication-mode aaa');
  await huawei.executeCommand('protocol inbound ssh');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('ssh user admin authentication-type password');
  await huawei.executeCommand('ssh user admin service-type stelnet');
  await huawei.executeCommand('quit');
  return { winA, winB, linuxA, linuxB, cisco, huawei };
}

describe('SSH is a transparent transport for every host vendor', () => {
  describe('Windows host', () => {
    it('Win -> Win lands on a real WindowsTerminalSession', async () => {
      const { winA } = await buildLab();
      const host = new WindowsTerminalSession('h', winA);
      await host.init?.();
      await sshLogin(host, 'ssh User@10.0.0.2', 'user');
      expect(host.foreground).not.toBe(host);
      expect(host.foreground).toBeInstanceOf(WindowsTerminalSession);
      expect(host.foreground.isRemoteChild).toBe(true);
    });

    it('Win -> Cisco lands on a real CiscoTerminalSession', async () => {
      const { winA } = await buildLab();
      const host = new WindowsTerminalSession('h', winA);
      await host.init?.();
      await sshLogin(host, 'ssh admin@10.0.0.5', 'Admin@123');
      expect(host.foreground).not.toBe(host);
      expect(host.foreground).toBeInstanceOf(CiscoTerminalSession);
      expect(host.foreground.isRemoteChild).toBe(true);
    });

    it('Win -> Huawei lands on a real HuaweiTerminalSession', async () => {
      const { winA } = await buildLab();
      const host = new WindowsTerminalSession('h', winA);
      await host.init?.();
      await sshLogin(host, 'ssh admin@10.0.0.6', 'Admin@123');
      expect(host.foreground).not.toBe(host);
      expect(host.foreground).toBeInstanceOf(HuaweiTerminalSession);
      expect(host.foreground.isRemoteChild).toBe(true);
    });
  });

  describe('Linux host', () => {
    it('Linux -> Linux lands on a real LinuxTerminalSession', async () => {
      const { linuxA } = await buildLab();
      const host = new LinuxTerminalSession('h', linuxA);
      await host.init?.();
      await sshLogin(host, 'ssh user@10.0.0.4', 'admin');
      expect(host.foreground).not.toBe(host);
      expect(host.foreground).toBeInstanceOf(LinuxTerminalSession);
      expect(host.foreground.isRemoteChild).toBe(true);
    });

    it('Linux -> Linux streams ping reply-by-reply over SSH', async () => {
      const { linuxA } = await buildLab();
      const host = new LinuxTerminalSession('h', linuxA);
      await host.init?.();
      await sshLogin(host, 'ssh user@10.0.0.4', 'admin');
      runOnForeground(host, 'ping 10.0.0.3');
      await tick();
      expect(host.foreground.hasForegroundAsyncJob).toBe(true);
      await waitFor(host, (l) => l.some((t) => /bytes from 10\.0\.0\.3/.test(t)));
      host.handleKey(key('c', { ctrlKey: true }));
      await tick();
      expect(host.foreground.hasForegroundAsyncJob).toBe(false);
    });

    it('Linux -> Win lands on a real WindowsTerminalSession', async () => {
      const { linuxA } = await buildLab();
      const host = new LinuxTerminalSession('h', linuxA);
      await host.init?.();
      await sshLogin(host, 'ssh User@10.0.0.1', 'user');
      expect(host.foreground).not.toBe(host);
      expect(host.foreground).toBeInstanceOf(WindowsTerminalSession);
      expect(host.foreground.isRemoteChild).toBe(true);
    });

    it('Linux -> Cisco lands on a real CiscoTerminalSession', async () => {
      const { linuxA } = await buildLab();
      const host = new LinuxTerminalSession('h', linuxA);
      await host.init?.();
      await sshLogin(host, 'ssh admin@10.0.0.5', 'Admin@123');
      expect(host.foreground).not.toBe(host);
      expect(host.foreground).toBeInstanceOf(CiscoTerminalSession);
      expect(host.foreground.isRemoteChild).toBe(true);
    });

    it('Linux -> Huawei lands on a real HuaweiTerminalSession', async () => {
      const { linuxA } = await buildLab();
      const host = new LinuxTerminalSession('h', linuxA);
      await host.init?.();
      await sshLogin(host, 'ssh admin@10.0.0.6', 'Admin@123');
      expect(host.foreground).not.toBe(host);
      expect(host.foreground).toBeInstanceOf(HuaweiTerminalSession);
      expect(host.foreground.isRemoteChild).toBe(true);
    });
  });

  describe('exit returns to the host on every pair', () => {
    it('Win -> Win + exit returns to the Windows host', async () => {
      const { winA } = await buildLab();
      const host = new WindowsTerminalSession('h', winA);
      await host.init?.();
      await sshLogin(host, 'ssh User@10.0.0.2', 'user');
      runOnForeground(host, 'exit');
      await tick();
      expect(host.foreground).toBe(host);
    });

    it('Linux -> Cisco + logout returns to the Linux host', async () => {
      const { linuxA } = await buildLab();
      const host = new LinuxTerminalSession('h', linuxA);
      await host.init?.();
      await sshLogin(host, 'ssh admin@10.0.0.5', 'Admin@123');
      runOnForeground(host, 'logout');
      await tick();
      expect(host.foreground).toBe(host);
    });
  });
});
