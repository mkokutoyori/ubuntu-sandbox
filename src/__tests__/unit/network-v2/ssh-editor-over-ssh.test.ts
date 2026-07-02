import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 30));
async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 6 && host.foreground.currentInputMode.type !== 'password'; i++) await tick();
  if (host.foreground.currentInputMode.type === 'password') {
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

describe('Editors open and save correctly when invoked through SSH', () => {
  let winA: WindowsPC;
  let linuxA: LinuxPC;
  let host: WindowsTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    winA = new WindowsPC('windows-pc', 'winA', 0, 0);
    linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
    [winA, linuxA, sw].forEach((d) => d.powerOn());
    new Cable('c1').connect(winA.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(linuxA.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await winA.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.1 255.255.255.0');
    await linuxA.executeCommand('ifconfig eth0 10.0.0.2');
    host = new WindowsTerminalSession('term-1', winA);
    await host.init?.();
  });

  it('nano on the remote enters editor mode visible from the Windows host', async () => {
    await sshLogin(host, 'ssh user@10.0.0.2', 'admin');
    runOnForeground(host, 'nano hello.txt');
    await tick();
    expect(host.currentInputMode.type).toBe('editor');
    const mode = host.currentInputMode as { editorType: string; filePath: string };
    expect(mode.editorType).toBe('nano');
    expect(mode.filePath).toMatch(/hello\.txt$/);
  });

  it('vi on the remote enters editor mode visible from the Windows host', async () => {
    await sshLogin(host, 'ssh user@10.0.0.2', 'admin');
    runOnForeground(host, 'vi hello.txt');
    await tick();
    expect(host.currentInputMode.type).toBe('editor');
    expect((host.currentInputMode as { editorType: string }).editorType).toBe('vi');
  });

  it('vim on the remote enters editor mode visible from the Windows host', async () => {
    await sshLogin(host, 'ssh user@10.0.0.2', 'admin');
    runOnForeground(host, 'vim hello.txt');
    await tick();
    expect(host.currentInputMode.type).toBe('editor');
    expect((host.currentInputMode as { editorType: string }).editorType).toBe('vim');
  });

  it('saving via the host editor overlay writes the file on the remote VFS', async () => {
    await sshLogin(host, 'ssh user@10.0.0.2', 'admin');
    runOnForeground(host, 'nano /tmp/note.txt');
    await tick();
    expect(host.currentInputMode.type).toBe('editor');
    host.editorSave('hello over ssh\n', '/tmp/note.txt');
    host.editorExit();
    await tick();
    const out = await linuxA.executeCommand('cat /tmp/note.txt');
    expect(out).toMatch(/hello over ssh/);
    expect(host.currentInputMode.type).not.toBe('editor');
  });

  it('exiting the editor without saving returns to the remote bash prompt', async () => {
    await sshLogin(host, 'ssh user@10.0.0.2', 'admin');
    runOnForeground(host, 'nano /tmp/throwaway.txt');
    await tick();
    expect(host.currentInputMode.type).toBe('editor');
    host.editorExit();
    await tick();
    expect(host.currentInputMode.type).not.toBe('editor');
    expect(host.foreground).toBeInstanceOf(LinuxTerminalSession);
  });
});
