/**
 * `config system global` : `set admin-ssh-password enable|disable` (FortiOS CLI Reference 7.4.12 : « Enable/disable password authentication for SSH admin access », defaut enable).
 * Desactive, le serveur SSH d'administration n'annonce plus la methode `password` et refuse un mot de passe meme exact ; la cle publique reste offerte. Le
 * reglage vit dans le plan de gestion et s'applique au rappel d'authentification du serveur, la ou passent toutes les connexions SSH.
 * Mesure de depart : « unknown attribute admin-ssh-password » ; 1 des 3 cas tombe avant (le refus) ; le temoin (mot de passe exact accepte) et « enable » explicite passent des deux cotes.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

const PASSWORD = 'S3cret!Pass';

async function lab(extra: readonly string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
  new Cable('c').connect(pc.getPort('eth0')!, fw.getPort('port1')!);
  for (const line of ['config system interface', 'edit "port1"', 'set mode static', 'set ip 10.0.10.2 255.255.255.0', 'set allowaccess ping ssh', 'next', 'end',
    'config system admin', 'edit "ops"', `set password "${PASSWORD}"`, 'set accprofile "super_admin"', 'next', 'end', ...extra]) await fw.executeCommand(line);
  await pc.executeCommand('ip addr add 10.0.10.9/24 dev eth0');
  await pc.executeCommand('ip link set eth0 up');
  return { fw, pc };
}

const login = (pc: LinuxPC) =>
  pc.executeCommand(`sshpass -p '${PASSWORD}' ssh -o StrictHostKeyChecking=accept-new ops@10.0.10.2 "get system status"`);

describe('system global admin-ssh-password', () => {
  it('temoin : par defaut le mot de passe exact ouvre la session', async () => {
    const { pc } = await lab([]);
    expect(await login(pc)).toContain('Version');
  });

  it('enable explicite : meme comportement', async () => {
    const { pc } = await lab(['config system global', 'set admin-ssh-password enable', 'end']);
    expect(await login(pc)).toContain('Version');
  });

  it('disable : le mot de passe exact est refuse', async () => {
    const { fw, pc } = await lab(['config system global', 'set admin-ssh-password disable', 'end']);
    expect(await fw.executeCommand('show system global')).toContain('set admin-ssh-password disable');
    expect(await login(pc)).toMatch(/Permission denied/);
  });
});
