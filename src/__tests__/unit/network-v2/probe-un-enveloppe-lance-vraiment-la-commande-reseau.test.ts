/*
 * `timeout`, `env` et `nohup` devant une commande reseau repondaient
 * « command not found », et `su -c` ne pouvait pas authentifier une
 * commande reseau.
 *
 * Mesure de depart, sur un LAN pc1 — srv1 :
 *
 *   timeout 5 ping -c 1 192.168.1.2    ping: command not found   (127)
 *   env FOO=bar ping -c 1 192.168.1.2  ping: command not found   (127)
 *   nohup ping -c 1 192.168.1.2        nohup: command not found
 *   su carol -c "ping …" (mot de passe juste)   su: Authentication failure
 *
 * et pourtant `arp -n` montrait srv1 apres coup : l'echo partait par un
 * autre chemin pendant que le terminal affichait un refus. Les tests de
 * `linux-bash-network-scripts` ne lisaient que la table ARP ; ils
 * passaient, et c'etait l'annonce ARP gratuite de srv1, non le ping, qui
 * la remplissait.
 *
 * L'AUTORITE EST COREUTILS (`timeout`, `env`, `nohup.c`) et util-linux
 * (`su`) : l'enveloppe EXECUTE la commande et en rend le statut ;
 * `nohup` ajoute la sortie a `nohup.out` (mode 0600) quand la sortie
 * standard est un terminal, en le disant — « ignoring input and appending
 * output to 'nohup.out' » —, renvoie l'erreur standard sur la sortie
 * quand celle-ci est redirigee — « ignoring input and redirecting stderr
 * to stdout » —, et sort en 125 sans operande. `su` lit le mot de passe
 * sur son entree.
 *
 * Ecrite a l'aveugle contre ces references, avant de lire les
 * enveloppes.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 6 des 8 cas tombent. Les deux TEMOINS passent des deux cotes : le ping
 * nu, et le refus d'un mauvais mot de passe, que `su` faisait deja.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
  [pc, srv, sw].forEach((d) => d.powerOn());
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await pc.executeCommand('ifconfig eth0 192.168.1.1');
  await srv.executeCommand('ifconfig eth0 192.168.1.2');
});

describe('a wrapper runs the network command it wraps', () => {
  it('bare ping answers — WITNESS', async () => {
    expect(await pc.executeCommand('ping -c 1 -W 1 192.168.1.2')).toMatch(/1 received/);
  });

  it('timeout runs ping and returns its status', async () => {
    expect(await pc.executeCommand('timeout 5 ping -c 1 -W 1 192.168.1.2')).toMatch(/1 received/);
    expect(await pc.executeCommand('echo $?')).toBe('0');
  });

  it('env runs ping under the extra variable', async () => {
    expect(await pc.executeCommand('env FOO=bar ping -c 1 -W 1 192.168.1.2')).toMatch(/1 received/);
  });
});

describe('nohup', () => {
  it('stdout on the terminal: the output goes to nohup.out, mode 0600', async () => {
    expect(await pc.executeCommand('nohup ping -c 1 -W 1 192.168.1.2'))
      .toBe("nohup: ignoring input and appending output to 'nohup.out'");
    expect(await pc.executeCommand('cat nohup.out')).toMatch(/1 received/);
    expect(await pc.executeCommand('stat -c %a nohup.out')).toBe('600');
  });

  it('stdout redirected: stderr follows stdout, and nohup says so', async () => {
    expect(await pc.executeCommand('nohup ping -c 1 -W 1 192.168.1.2 >/dev/null'))
      .toBe('nohup: ignoring input and redirecting stderr to stdout');
  });

  it('no operand: exit 125', async () => {
    expect(await pc.executeCommand('nohup')).toBe("nohup: missing operand\nTry 'nohup --help' for more information.");
    expect(await pc.executeCommand('echo $?')).toBe('125');
  });
});

describe('su -c', () => {
  it('authenticates with the password on stdin and runs the network command as the target user', async () => {
    await pc.executeCommand('sudo useradd -m -s /bin/bash carol');
    await pc.executeCommand('echo carol:carolpw | sudo chpasswd');

    expect(await pc.executeCommand('su carol -c "ping -c 1 -W 1 192.168.1.2 >/dev/null; whoami"', 'carolpw\n'))
      .toBe('carol');
    expect(await pc.executeCommand('whoami')).toBe('user');
  });

  it('a wrong password is refused — WITNESS', async () => {
    await pc.executeCommand('sudo useradd -m -s /bin/bash carol');
    await pc.executeCommand('echo carol:carolpw | sudo chpasswd');

    expect(await pc.executeCommand('su carol -c "ping -c 1 -W 1 192.168.1.2"', 'wrong\n'))
      .toBe('su: Authentication failure');
  });
});
