import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

async function typeCommand(session: LinuxTerminalSession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Action-driven flow (bug #1: alias should not bypass sudo password)', () => {
  it('triggers the sudo password prompt when sudo is invoked via an alias', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('term-alias', pc);

    await typeCommand(session, "alias please='sudo'");
    expect(session.currentInputMode.type).toBe('normal');

    await typeCommand(session, 'please su');
    expect(session.currentInputMode.type).toBe('password');
  });

  it('still triggers the sudo password prompt when typed directly', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('term-direct', pc);

    await typeCommand(session, 'sudo su');
    expect(session.currentInputMode.type).toBe('password');
  });

  it('triggers the passwd flow when invoked via an alias', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('term-passwd', pc);
    await typeCommand(session, "alias chpw='passwd'");
    await typeCommand(session, 'chpw');
    expect(session.currentInputMode.type).toBe('password');
  });

  it('routes aliased ssh through the ssh entry, not generic exec', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('term-myssh', pc);
    await typeCommand(session, "alias myssh='ssh'");
    await typeCommand(session, 'myssh notahost@10.0.0.99');
    await flush(20);
    const text = (session as unknown as { lines: { text?: string; segments?: { text: string }[] }[] }).lines
      .map(l => l.text ?? (l.segments ?? []).map(s => s.text).join(''))
      .join('\n');
    expect(text).toMatch(/ssh:|No route to host|Permission denied|connect/i);
  });

  it('resolves chained aliases before flow dispatch', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('term-chain', pc);

    await typeCommand(session, "alias please='sudo'");
    await typeCommand(session, "alias root='please su'");
    await typeCommand(session, 'root');
    expect(session.currentInputMode.type).toBe('password');
  });
});

describe('PowerShell shim (bug #2: bare-arg powershell)', () => {
  it('evaluates `powershell <expression>` without requiring -Command', async () => {
    const pc = new WindowsPC('win-pc', 'WIN1');
    const out = await pc.executeCmdCommand('powershell $x = 42; $x');
    expect(out.trim()).toBe('42');
  });

  it('keeps explicit -Command form working', async () => {
    const pc = new WindowsPC('win-pc', 'WIN1');
    const out = await pc.executeCmdCommand('powershell -Command "$x = 7; $x"');
    expect(out.trim()).toBe('7');
  });

  it('does not return the Usage banner for `powershell gcm`', async () => {
    const pc = new WindowsPC('win-pc', 'WIN1');
    const out = await pc.executeCmdCommand('powershell gcm');
    expect(out).not.toMatch(/Usage:/);
  });
});

async function buildMixedLan(): Promise<{ linux1: LinuxPC; ciscoR1: CiscoRouter; hwR1: HuaweiRouter; }> {
  EquipmentRegistry.getInstance().clear();
  const linux1 = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const ciscoR1 = new CiscoRouter('ciscoR1', 0, 0);
  const hwR1 = new HuaweiRouter('hwR1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 8, 0, 0);
  [linux1, ciscoR1, hwR1].forEach((d, i) => {
    const c = new Cable(`c${i}`);
    c.connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  const mask = new SubnetMask('255.255.255.0');
  linux1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);

  await ciscoR1.executeCommand('enable');
  await ciscoR1.executeCommand('configure terminal');
  await ciscoR1.executeCommand('hostname ciscoR1');
  await ciscoR1.executeCommand('interface GigabitEthernet0/0');
  await ciscoR1.executeCommand('ip address 10.0.0.6 255.255.255.0');
  await ciscoR1.executeCommand('no shutdown');
  await ciscoR1.executeCommand('username admin privilege 15 secret Admin@123');
  await ciscoR1.executeCommand('enable secret Admin@123');
  await ciscoR1.executeCommand('ip domain-name lab.local');
  await ciscoR1.executeCommand('crypto key generate rsa modulus 2048');
  await ciscoR1.executeCommand('ip ssh version 2');
  await ciscoR1.executeCommand('line vty 0 4');
  await ciscoR1.executeCommand('login local');
  await ciscoR1.executeCommand('transport input ssh');
  await ciscoR1.executeCommand('exit');
  await ciscoR1.executeCommand('end');

  await hwR1.executeCommand('system-view');
  await hwR1.executeCommand('sysname hwR1');
  await hwR1.executeCommand('interface GigabitEthernet0/0/0');
  await hwR1.executeCommand('ip address 10.0.0.8 255.255.255.0');
  await hwR1.executeCommand('undo shutdown');
  await hwR1.executeCommand('quit');
  await hwR1.executeCommand('aaa');
  await hwR1.executeCommand('local-user admin password cipher Admin@123');
  await hwR1.executeCommand('local-user admin service-type ssh');
  await hwR1.executeCommand('local-user admin privilege level 15');
  await hwR1.executeCommand('quit');
  await hwR1.executeCommand('rsa local-key-pair create');
  await hwR1.executeCommand('stelnet server enable');
  await hwR1.executeCommand('user-interface vty 0 4');
  await hwR1.executeCommand('authentication-mode aaa');
  await hwR1.executeCommand('protocol inbound ssh');
  await hwR1.executeCommand('quit');
  await hwR1.executeCommand('ssh user admin authentication-type password');
  await hwR1.executeCommand('ssh user admin service-type stelnet');
  await hwR1.executeCommand('quit');

  return { linux1, ciscoR1, hwR1 };
}

describe.todo('Cross-equipment interactive SSH (bug #3 — needs router/Windows SSH TCP server)', () => {
  it('opens a Cisco IOS prompt when SSH-ing without a command from a Linux PC', async () => {
    const { linux1 } = await buildMixedLan();
    const session = new LinuxTerminalSession('term-cisco-ssh', linux1);

    await typeCommand(session, 'ssh admin@10.0.0.6');
    await flush(40);
    if (session.currentInputMode.type === 'password') {
      session.setPasswordBuf('Admin@123');
      session.handleKey(key('Enter'));
      await flush(20);
    }

    if (!session.isInsideSshSession) {
      const text = (session as unknown as { lines: { text?: string; segments?: { text: string }[] }[] }).lines
        .map(l => l.text ?? (l.segments ?? []).map(s => s.text).join(''))
        .join('\n');
      throw new Error('Not in SSH session. Output:\n' + text);
    }
    expect(session.isInsideSshSession).toBe(true);
    const prompt = session.getPromptParts();
    expect(prompt.user + prompt.path + prompt.promptChar).toMatch(/ciscoR1/);
  });

  it('opens a Huawei VRP prompt when SSH-ing without a command from a Linux PC', async () => {
    const { linux1 } = await buildMixedLan();
    const session = new LinuxTerminalSession('term-hw-ssh', linux1);

    await typeCommand(session, 'ssh admin@10.0.0.8');
    if (session.currentInputMode.type === 'password') {
      session.setPasswordBuf('Admin@123');
      session.handleKey(key('Enter'));
      await flush(20);
    }

    expect(session.isInsideSshSession).toBe(true);
    const prompt = session.getPromptParts();
    const joined = prompt.user + prompt.path + prompt.promptChar;
    expect(joined).toMatch(/hwR1|<hwR1>/);
  });
});
