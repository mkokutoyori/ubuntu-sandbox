/**
 * Sonde — un commutateur Huawei acceptait toute la configuration SSH et
 * n'ecoutait jamais.
 *
 * Mesure AVANT (sur `371b9309'), sur un S5720 cable a un `LinuxPC',
 * entree standard `Admin@123\ndisplay version\nquit\n' :
 *
 *   rsa local-key-pair create -> "Error: Unrecognized command found at
 *                                 '^' position."
 *   stelnet server enable     -> accepte, sans effet
 *   listListeners()           -> [23]
 *   ssh admin@10.0.1.2        -> "ssh: connect to host 10.0.1.2 port 22:
 *                                 Connection refused"
 *   telnet 10.0.1.2           -> "<HW2>" DIRECTEMENT, sans `Username:'
 *
 * Le routeur Huawei, lui, ouvrait deja une vraie session depuis le lot
 * des equipements non Linux : c'est le COMMUTATEUR qui restait muet.
 *
 * TROIS causes, et la derniere n'est pas une absence mais une porte
 * ouverte.
 *
 * 1. `rsa local-key-pair create' n'existait que sur le shell du ROUTEUR
 *    (`HuaweiVRPShell'). Sans paire de cles il n'y a rien a presenter,
 *    donc `isSshActive()' restait faux et le port 22 ne s'ouvrait
 *    jamais. C'est le pendant exact de `crypto key generate rsa' cote
 *    Cisco, que le commutateur Cisco avait deja.
 *
 * 2. `stelnet server enable' etait ACCEPTE et rendu dans la
 *    configuration sans que rien ne le lise : `Switch' n'avait ni
 *    `_setSshServerEnabled', ni `hasSshHostKeys', ni service de paires
 *    de cles -- tout cela vivait sur `Router'. La forme exacte que la
 *    regle 6 nomme.
 *
 * 3. `authentication-mode aaa' etait range dans une carte d'AFFICHAGE
 *    (`userInterfaceExtraConfig') et jamais consulte. Le commutateur
 *    demandait donc la question de connexion a la Cisco -- `login
 *    local' -- qui n'est jamais posee sur un VRP : le telnet ouvrait
 *    une session SANS rien demander. Un critere de securite range et
 *    non evalue, qui echoue OUVERT. Le routeur, lui, avait la bonne
 *    regle dans `resolveVtyLoginMode' : DEUX ecritures d'une meme
 *    question, et la copie du commutateur etait la plus permissive --
 *    exactement le piege que le depot decrit. Elle est ecrite une fois,
 *    `vtyLoginModeOf', et les deux la lisent.
 *
 * SEPT cas sur dix tombent avant la correction (discrimines sur
 * `371b9309'). Les TROIS autres sont NOMMES :
 *
 *   - le routeur Huawei execute deja la commande : TEMOIN. Il prouve que
 *     le vocabulaire VRP, le compte et la CLI sont bons, donc qu'un
 *     commutateur muet est un chemin manquant et non un laboratoire
 *     casse.
 *   - sans paire de cles, le port 22 reste ferme : TEMOIN, et c'est deja
 *     le bon comportement. Il doit le rester APRES : un commutateur sans
 *     cle n'a pas de serveur SSH, et c'est ce qui distingue la
 *     correction d'un port ouvert en permanence.
 *   - `undo stelnet server enable' referme le port 22 : passe AVANT
 *     comme APRES, mais A VIDE avant -- le port n'etait jamais ouvert,
 *     donc rien ne pouvait le refermer. Il est ecrit parce qu'il a
 *     attrape un defaut reel : `undo stelnet server enable' n'etait
 *     traite que dans le `cmdUndo' du ROUTEUR, si bien que le
 *     commutateur l'acceptait sans rien fermer une fois le port
 *     reellement ouvert. L'undo est desormais declare une seule fois,
 *     a cote du `stelnet' qu'il annule, et les deux shells le
 *     partagent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const SW_IP = '10.0.1.2';
const PC_IP = '10.0.1.10';

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function lab(withKeys = true): Promise<{ pc: LinuxPC; sw: HuaweiSwitch }> {
  const sw = new HuaweiSwitch('switch-huawei', 'HW2', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'P2');
  pc.getPort('eth0')!.configureIP(new IPAddress(PC_IP), MASK);
  new Cable('c2').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  const lines = [
    'system-view', 'sysname HW2',
    'interface Vlanif1', `ip address ${SW_IP} 255.255.255.0`, 'undo shutdown', 'quit',
    'aaa', 'local-user admin password cipher Admin@123',
    'local-user admin service-type ssh', 'local-user admin privilege level 15', 'quit',
  ];
  if (withKeys) lines.push('rsa local-key-pair create');
  lines.push(
    'stelnet server enable',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound all', 'quit',
    'ssh user admin authentication-type password', 'ssh user admin service-type stelnet',
    'quit',
  );
  for (const l of lines) await sw.executeCommand(l);
  await settle();
  return { pc, sw };
}

function listeners(sw: HuaweiSwitch): number[] {
  return (sw as unknown as { getTcpStack(): { listListeners(): Array<{ localPort: number }> } })
    .getTcpStack().listListeners().map((l) => l.localPort).sort((a, b) => a - b);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('un commutateur Huawei repond vraiment en SSH', () => {
  it('temoin : le routeur Huawei, lui, executait deja la commande', async () => {
    const hw = new HuaweiRouter('HW1', 0, 0);
    const pc = new LinuxPC('linux-pc', 'P1');
    pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
    new Cable('c1').connect(pc.getPort('eth0')!, hw.getPorts()[0]);
    for (const l of [
      'system-view', 'sysname HW1',
      `interface ${hw.getPorts()[0].name}`, 'ip address 10.0.0.2 255.255.255.0', 'undo shutdown', 'quit',
      'aaa', 'local-user admin password cipher Admin@123',
      'local-user admin service-type ssh', 'local-user admin privilege level 15', 'quit',
      'rsa local-key-pair create', 'stelnet server enable',
      'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound all', 'quit',
      'ssh user admin authentication-type password', 'ssh user admin service-type stelnet', 'quit',
    ]) await hw.executeCommand(l);
    await settle();
    expect(await pc.executeCommand('ssh admin@10.0.0.2', 'Admin@123\ndisplay version\nquit\n'))
      .toContain('BOARD TYPE');
  }, 30000);

  it('temoin : sans paire de cles, le port 22 reste ferme', async () => {
    const { pc, sw } = await lab(false);
    expect(listeners(sw)).not.toContain(22);
    expect(await pc.executeCommand(`ssh admin@${SW_IP}`, 'Admin@123\ndisplay version\nquit\n'))
      .toContain('Connection refused');
  }, 30000);

  it('`rsa local-key-pair create` est une commande du commutateur', async () => {
    const { sw } = await lab(true);
    await sw.executeCommand('system-view');
    expect(await sw.executeCommand('rsa local-key-pair create'))
      .not.toContain('Unrecognized command');
  }, 30000);

  it('la paire de cles ouvre le port 22', async () => {
    const { sw } = await lab(true);
    expect(listeners(sw)).toContain(22);
  }, 30000);

  it('la commande saisie est reellement executee par la CLI du commutateur', async () => {
    const { pc } = await lab(true);
    expect(await pc.executeCommand(`ssh admin@${SW_IP}`, 'Admin@123\ndisplay version\nquit\n'))
      .toContain('S5720');
  }, 30000);

  it('un mot de passe FAUX est refuse', async () => {
    const { pc } = await lab(true);
    const out = await pc.executeCommand(`ssh admin@${SW_IP}`, 'NOPE\ndisplay version\nquit\n');
    expect(out).not.toContain('S5720');
    expect(out).toContain('Permission denied');
  }, 30000);

  it('un compte inconnu est refuse', async () => {
    const { pc } = await lab(true);
    const out = await pc.executeCommand(`ssh ghost@${SW_IP}`, 'Admin@123\ndisplay version\nquit\n');
    expect(out).not.toContain('S5720');
    expect(out).toContain('Permission denied');
  }, 30000);

  it('`authentication-mode aaa` ferme aussi la porte du telnet', async () => {
    const { pc } = await lab(true);
    const out = await pc.executeCommand(`telnet ${SW_IP}`, 'admin\nAdmin@123\ndisplay version\nquit\n');
    expect(out).toContain('Username:');
    expect(out).toContain('S5720');
  }, 30000);

  it('en telnet aussi, un mot de passe FAUX est refuse', async () => {
    const { pc } = await lab(true);
    const out = await pc.executeCommand(`telnet ${SW_IP}`, 'admin\nNOPE\ndisplay version\nquit\n');
    expect(out).toContain('% Login invalid');
    expect(out).not.toContain('S5720');
  }, 30000);

  it('`undo stelnet server enable` referme le port 22', async () => {
    const { pc, sw } = await lab(true);
    await sw.executeCommand('system-view');
    await sw.executeCommand('undo stelnet server enable');
    await settle();
    expect(listeners(sw)).not.toContain(22);
    expect(await pc.executeCommand(`ssh admin@${SW_IP}`, 'Admin@123\ndisplay version\nquit\n'))
      .toContain('Connection refused');
  }, 30000);
});
