/**
 * `config system global` : `set admin-login-max <1-100>` (FortiOS CLI Reference 7.4.12 : « Maximum number of administrators who can be logged in at the same time »,
 * defaut 100). Une connexion SSH de plus, quand la table des sessions administrateur est pleine, est refusee meme avec le bon mot de passe ; fermer une
 * session libere la place. Le plafond vit dans le pare-feu et s'applique a `authenticateAdmin`, le point par lequel passent les connexions de gestion.
 * `set admin-concurrent disable` (meme reference) refuse une seconde session du meme compte. Mesure de depart : « unknown attribute admin-login-max » et aucun plafond ; contre le commit precedent 1 des 4 cas tombe (admin-concurrent) ; avant admin-login-max, 2 des 4 tombaient (le plafond, admin-concurrent) ; le temoin (deux sessions sans plafond) et la place liberee apres une deconnexion passent des deux cotes.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((r) => setTimeout(r, 25));

async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 10 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 10; i++) await tick();
}

async function lab() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const shell = fw.getShell() as FortiShell;
  const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
  pc.powerOn();
  new Cable('a').connect(pc.getPort('eth0')!, fw.getPort('port1')!);
  for (const line of ['config system interface', 'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh', 'next', 'end',
    'config system admin', 'edit "admin"', 'set password "Secret123"', 'set accprofile "super_admin"', 'next', 'end']) shell.execute(line);
  await pc.executeCommand('ip link set eth0 up');
  await pc.executeCommand('ip addr add 192.168.1.10/24 dev eth0');
  const open = async () => {
    const host = new LinuxTerminalSession('h', pc);
    await host.init?.();
    await sshLogin(host, 'ssh -o StrictHostKeyChecking=accept-new admin@192.168.1.1', 'Secret123');
    return host;
  };
  return { fw, shell, open };
}

describe('system global admin-login-max', () => {
  it('temoin : sans plafond deux sessions cohabitent', async () => {
    const { fw, open } = await lab();
    await open();
    await open();
    expect(fw.getAdminSessions().list()).toHaveLength(2);
  });

  it('le plafond est rendu et refuse une session de trop', async () => {
    const { fw, shell, open } = await lab();
    for (const line of ['config system global', 'set admin-login-max 1', 'end']) shell.execute(line);
    expect(shell.execute('show system global')).toContain('set admin-login-max 1');
    await open();
    await open();
    expect(fw.getAdminSessions().list()).toHaveLength(1);
  });

  it('fermer la session libere la place', async () => {
    const { fw, shell, open } = await lab();
    for (const line of ['config system global', 'set admin-login-max 1', 'end']) shell.execute(line);
    await open();
    const index = fw.getAdminSessions().list()[0].index;
    shell.execute(`execute disconnect-admin-session ${index}`);
    await open();
    expect(fw.getAdminSessions().list()).toHaveLength(1);
  });

  it('admin-concurrent disable refuse une seconde session du meme compte', async () => {
    const { fw, shell, open } = await lab();
    for (const line of ['config system global', 'set admin-concurrent disable', 'end']) shell.execute(line);
    expect(shell.execute('show system global')).toContain('set admin-concurrent disable');
    await open();
    await open();
    expect(fw.getAdminSessions().list()).toHaveLength(1);
  });
});
