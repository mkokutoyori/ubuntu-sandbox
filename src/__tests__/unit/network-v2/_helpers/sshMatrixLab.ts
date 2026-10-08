import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createSessionForDevice } from '@/terminal/sessions/sessionFactory';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { DeviceType } from '@/network/core/types';
import type { Equipment } from '@/network/equipment/Equipment';
import { allowLegacyIosSsh } from '../iosLegacySsh';

export const SECRET = 'Secret123';
export const ADMIN = 'netadmin';

export type Kind =
  | 'linux-pc' | 'linux-server' | 'windows-pc' | 'windows-server'
  | 'router-cisco' | 'switch-cisco' | 'router-huawei' | 'switch-huawei'
  | 'firewall-cisco' | 'firewall-fortinet';

export const ALL_KINDS: readonly Kind[] = [
  'linux-pc', 'linux-server', 'windows-pc', 'windows-server',
  'router-cisco', 'switch-cisco', 'router-huawei', 'switch-huawei',
  'firewall-cisco', 'firewall-fortinet',
];

export interface Node {
  kind: Kind;
  name: string;
  ip: string;
  device: Equipment;
  user: string;
  secret: string;
}

export interface MatrixLab { nodes: Node[]; switchDevice: GenericSwitch }

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

const NAME_OF: Record<Kind, string> = {
  'linux-pc': 'lpc', 'linux-server': 'lsrv', 'windows-pc': 'wpc', 'windows-server': 'wsrv',
  'router-cisco': 'ior', 'switch-cisco': 'ios', 'router-huawei': 'vrr', 'switch-huawei': 'vrs',
  'firewall-cisco': 'asa', 'firewall-fortinet': 'fgt',
};

async function run(device: Equipment, commands: readonly string[]): Promise<void> {
  for (const command of commands) await (device as unknown as Cli).executeCommand(command);
}

async function configureNode(node: Node, mask: string): Promise<void> {
  const { device, name, ip, kind } = node;
  switch (kind) {
    case 'linux-pc':
    case 'linux-server':
      await run(device, [
        `sudo hostnamectl set-hostname ${name}`,
        `sudo ip addr add ${ip}/24 dev eth0`, 'sudo ip link set eth0 up',
        `sudo useradd -m -s /bin/bash ${ADMIN}`,
        `echo '${ADMIN}:${SECRET}' | sudo chpasswd`,
      ]);
      return;
    case 'windows-pc':
    case 'windows-server':
      await run(device, [
        `netsh interface ip set address "Ethernet 0" static ${ip} ${mask}`,
        ...(kind === 'windows-server' ? [`net user ${ADMIN} ${SECRET} /add`] : []),
      ]);
      return;
    case 'router-cisco':
      await run(device, [
        'enable', 'configure terminal', `hostname ${name}`, 'ip domain-name lab.local',
        `username ${ADMIN} privilege 15 secret ${SECRET}`,
        'crypto key generate rsa modulus 2048', 'ip ssh version 2',
        'interface GigabitEthernet0/0', `ip address ${ip} ${mask}`, 'no shutdown', 'exit',
        'line vty 0 4', 'login local', 'transport input ssh', 'end',
      ]);
      return;
    case 'switch-cisco':
      await run(device, [
        'enable', 'configure terminal', `hostname ${name}`, 'ip domain-name lab.local',
        `username ${ADMIN} privilege 15 secret ${SECRET}`,
        'crypto key generate rsa modulus 2048', 'ip ssh version 2',
        'interface Vlan1', `ip address ${ip} ${mask}`, 'no shutdown', 'exit',
        'line vty 0 4', 'login local', 'transport input ssh', 'end',
      ]);
      return;
    case 'router-huawei':
      await run(device, [
        'system-view', `sysname ${name}`,
        'interface GigabitEthernet0/0/0', `ip address ${ip} ${mask}`, 'undo shutdown', 'quit',
        'aaa', `local-user ${ADMIN} password cipher ${SECRET}`,
        `local-user ${ADMIN} service-type ssh`, `local-user ${ADMIN} privilege level 15`, 'quit',
        'rsa local-key-pair create', 'stelnet server enable',
        'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit',
        `ssh user ${ADMIN} authentication-type password`, `ssh user ${ADMIN} service-type stelnet`,
        'quit',
      ]);
      return;
    case 'switch-huawei':
      await run(device, [
        'system-view', `sysname ${name}`,
        'interface Vlanif1', `ip address ${ip} ${mask}`, 'quit',
        'aaa', `local-user ${ADMIN} password cipher ${SECRET}`,
        `local-user ${ADMIN} service-type ssh`, `local-user ${ADMIN} privilege level 15`, 'quit',
        'rsa local-key-pair create', 'stelnet server enable',
        'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit',
        `ssh user ${ADMIN} authentication-type password`, `ssh user ${ADMIN} service-type stelnet`,
        'quit',
      ]);
      return;
    case 'firewall-cisco': {
      const port = (device as unknown as { getPorts(): Array<{ getName(): string }> }).getPorts()[0].getName();
      await run(device, [
        'enable', 'configure terminal', `hostname ${name}`,
        `interface ${port}`, 'nameif inside', 'security-level 100',
        `ip address ${ip} ${mask}`, 'no shutdown', 'exit',
        `username ${ADMIN} password ${SECRET} privilege 15`,
        'ssh 10.0.0.0 255.255.255.0 inside', 'crypto key generate rsa modulus 2048', 'end',
      ]);
      return;
    }
    case 'firewall-fortinet': {
      const shell = (device as unknown as { getShell(): { execute(l: string): unknown } }).getShell();
      for (const line of [
        `config system global`, `set hostname ${name}`, 'end',
        'config system interface', 'edit "port1"', 'set mode static',
        `set ip ${ip} ${mask}`, 'set allowaccess ping ssh', 'next', 'end',
        'config system admin', `edit "${ADMIN}"`, `set password "${SECRET}"`,
        'set accprofile "super_admin"', 'next', 'end',
      ]) shell.execute(line);
      return;
    }
  }
}

function firstPort(kind: Kind, device: Equipment): Parameters<Cable['connect']>[0] {
  if (kind === 'firewall-fortinet') {
    return (device as unknown as { getPort(n: string): never }).getPort('port1');
  }
  return device.getPorts()[0];
}

export async function buildMatrixLab(kinds: readonly Kind[] = ALL_KINDS): Promise<MatrixLab> {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
  const switchDevice = new GenericSwitch('switch-generic', 'core', 16, 0, 0);
  switchDevice.powerOn();
  const nodes: Node[] = [];
  for (const [i, kind] of kinds.entries()) {
    const device = createDevice(kind as DeviceType, i * 100, 100, NAME_OF[kind]);
    device.powerOn();
    new Cable(`cab${i}`).connect(firstPort(kind, device), switchDevice.getPorts()[i]);
    const standardUser = kind === 'windows-pc';
    nodes.push({
      kind, name: NAME_OF[kind], ip: `10.0.0.${i + 11}`, device,
      user: standardUser ? 'User' : ADMIN, secret: standardUser ? 'user' : SECRET,
    });
  }
  for (const node of nodes) await configureNode(node, '255.255.255.0');
  for (const node of nodes) {
    if (node.kind === 'linux-pc' || node.kind === 'linux-server'
      || node.kind === 'windows-pc' || node.kind === 'windows-server') {
      allowLegacyIosSsh(node.device);
    }
  }
  return { nodes, switchDevice };
}

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((r) => setTimeout(r, 15));

export class Console {
  constructor(readonly session: TerminalSession) {}

  static async open(device: Equipment): Promise<Console> {
    const session = createSessionForDevice(device, `s-${device.getName()}`)!;
    await session.init?.();
    for (let i = 0; i < 80 && (session as unknown as { isBooting?: boolean }).isBooting; i++) await tick();
    const console = new Console(session);
    if (device.getOSType() === 'fortios') {
      await console.type(ADMIN);
      if (console.mode === 'password') await console.password(SECRET);
    }
    return console;
  }

  async expectPrompt(pattern: RegExp, timeoutMs = 4000): Promise<boolean> {
    for (let waited = 0; waited < timeoutMs; waited += 15) {
      if (pattern.test(this.prompt)) return true;
      await tick();
    }
    return pattern.test(this.prompt);
  }

  async type(line: string): Promise<void> {
    const s = this.session;
    s.foreground.setInput(line); s.foreground.setInputBuf(line); s.handleKey(key('Enter'));
    await this.settle();
  }

  async password(secret: string): Promise<void> {
    const s = this.session;
    s.setPasswordBuf(secret); s.setInputBuf(secret); s.handleKey(key('Enter'));
    await this.settle();
  }

  async settle(): Promise<void> {
    let last = '';
    let stable = 0;
    for (let i = 0; i < 400 && stable < 6; i++) {
      await tick();
      const now = `${this.session.lines.length}|${this.prompt}|${this.mode}`;
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  }

  get prompt(): string { return this.session.foreground.getPrompt(); }
  get transcript(): string { return this.session.lines.map((l) => l.text).join('\n'); }
  get mode(): string { return this.session.currentInputMode.type; }

  get promptText(): string {
    return (this.session.currentInputMode as { promptText?: string }).promptText ?? '';
  }

  private get state(): string { return `${this.mode}|${this.promptText}|${this.prompt}`; }

  private async untilChanged(before: string): Promise<void> {
    for (let i = 0; i < 300 && this.state === before; i++) await tick();
    await this.settle();
  }

  async answerPending(secret: string, user?: string): Promise<void> {
    for (let step = 0; step < 6; step++) {
      const asked = this.promptText;
      const before = this.state;
      if (this.mode === 'password') { await this.password(secret); await this.untilChanged(before); continue; }
      if (/continue connecting/.test(asked)) { await this.type('yes'); await this.untilChanged(before); continue; }
      if (/username/i.test(asked) && user) { await this.type(user); await this.untilChanged(before); continue; }
      break;
    }
  }

  async login(command: string, secret: string, user?: string): Promise<void> {
    const before = this.state;
    await this.type(command);
    await this.untilChanged(before);
    await this.answerPending(secret, user);
  }
}

export const clientCommand = (from: Kind, to: Node): string => {
  switch (from) {
    case 'router-cisco': case 'switch-cisco': return `ssh -l ${to.user} ${to.ip}`;
    case 'router-huawei': case 'switch-huawei': return `stelnet ${to.ip}`;
    case 'firewall-fortinet': return `execute ssh ${to.user}@${to.ip}`;
    default: return `ssh ${to.user}@${to.ip}`;
  }
};

export const remotePrompt = (to: Node): RegExp => {
  switch (to.kind) {
    case 'linux-pc': case 'linux-server': return new RegExp(`${to.user}@${to.name}`);
    case 'windows-pc': case 'windows-server': return new RegExp(`C:\\\\Users\\\\${to.user}>`, 'i');
    case 'router-huawei': case 'switch-huawei': return new RegExp(`<${to.name}>`);
    case 'firewall-fortinet': return new RegExp(`${to.name} [#$]`);
    default: return new RegExp(`${to.name}[#>]`);
  }
};

export const identityProbe = (to: Node): { command: string; expected: RegExp } => {
  switch (to.kind) {
    case 'linux-pc': case 'linux-server': case 'windows-pc': case 'windows-server':
      return { command: 'hostname', expected: new RegExp(`^${to.name}$`, 'm') };
    case 'router-huawei': case 'switch-huawei':
      return { command: 'display current-configuration | include sysname', expected: new RegExp(`sysname ${to.name}`) };
    case 'firewall-fortinet':
      return { command: 'get system status', expected: new RegExp(`Hostname: ${to.name}`) };
    default:
      return { command: 'show running-config | include hostname', expected: new RegExp(`hostname ${to.name}`) };
  }
};

export const logoutCommand = (to: Node): string => {
  if (to.kind === 'router-huawei' || to.kind === 'switch-huawei') return 'quit';
  return to.kind === 'firewall-cisco' ? 'logout' : 'exit';
};

