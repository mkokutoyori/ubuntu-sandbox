/**
 * Le meme acces administratif rend le MEME verdict, quelle que soit la
 * machine d'ou l'on part.
 *
 * MESURE DE DEPART, sur la topologie d'un operateur. Un pare-feu dont
 * port1 `192.168.1.99/24` porte `allowaccess ping https ssh http fgfm`
 * et port2 `192.168.20.2/30` porte `allowaccess ping` SEUL. Un routeur
 * Cisco tient le LAN (`192.168.1.1`) et route `192.168.20.0/30` vers
 * `192.168.1.99`. Un poste vise l'adresse de PORT2 :
 *
 *   client LINUX    ssh 192.168.20.2  ->  No route to host   (REFUSE)
 *   client WINDOWS  ssh 192.168.20.2  ->  invite « FW1 # »   (OUVERTE)
 *
 * Deux clients, deux reponses OPPOSEES au meme pare-feu, sur la meme
 * adresse, au meme instant.
 *
 * DEUX DEFAUTS, et aucun n'etait celui qu'on croyait.
 *
 * (1) Le refus de Linux n'etait PAS une decision d'`allowaccess`. Un cas
 * le prouve : en AJOUTANT `ssh` a port2, le refus persistait. Le client
 * `ssh` de Linux ne tente aucune connexion — il consulte d'abord un
 * oracle en memoire, `isPathReachable`, qui parcourt le cablage. Ce
 * parcours ne testait que les ports situes de l'AUTRE COTE d'un cable :
 * arrive au pare-feu par port1, il empilait les ports freres et testait
 * leurs voisins, sans jamais regarder les ports de la machine qu'il
 * venait d'atteindre. L'adresse de port2 etait donc introuvable des lors
 * qu'on n'arrivait pas par port2. Un equipement repond pourtant sur
 * TOUTES ses adresses — `destinedToSelf` du pare-feu le dit sans aucune
 * condition de lien.
 *
 * (2) Une fois le fil reparable, les deux origines s'accordaient... pour
 * OUVRIR la session que `allowaccess ping` aurait du refuser, parce que
 * le pare-feu evaluait `allowaccess` sur l'interface d'ENTREE. Sous cette
 * lecture, la commande est contournable par quiconque sait router : il
 * suffit d'entrer par une interface permissive pour atteindre n'importe
 * quelle adresse. Un critere qu'on range sans l'honorer, c'est le §6.
 * L'interface qui PORTE l'adresse visee decide desormais.
 *
 * CE QUI N'A PAS EU BESOIN D'ETRE TOUCHE : le chemin Windows. Il passe
 * par une session enfant en memoire (le « bypass » du PRD §4bis) et on
 * s'appretait a lui ajouter un controle ; la mesure a montre que reparer
 * le FIL suffit — les deux origines s'accordent sans qu'on duplique la
 * decision. Un controle de plus dans le bypass aurait ete une seconde
 * ecriture de la meme regle, et B4 l'aurait jete.
 *
 * DISCRIMINATION (`git stash push -- src/network`) : 2 des 6 cas
 * tombent, et le decompte merite d'etre detaille parce que DEUX des
 * quatre autres passent des deux cotes POUR DES RAISONS OPPOSEES :
 *
 *   - « Linux est refuse quand l'interface n'autorise que ping » passait
 *     AVANT parce que l'adresse etait jugee injoignable, et passe APRES
 *     parce qu'`allowaccess` decide. Meme verdict, cause inverse ;
 *   - « Windows ouvre quand ssh est ajoute » passait AVANT parce que
 *     Windows ouvrait TOUJOURS, et passe APRES parce que la regle
 *     l'autorise.
 *
 * Pris isolement, aucun des deux ne prouve rien. C'est la PAIRE
 * refus-sans-ssh / ouverture-avec-ssh qui montre qu'un critere decide,
 * et il faut les deux origines pour montrer qu'elles s'accordent.
 *
 * Les DEUX derniers sont les TEMOINS : l'acces legitime sur l'interface
 * qui l'autorise doit continuer de s'ouvrir depuis les deux origines,
 * sinon « tout refuser » passerait la sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 12 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 16; i++) await tick();
}

async function lab(allowOnPort2: string) {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  const sh = fw.getShell();
  const router = new CiscoRouter('Router2', 0, 0);
  const linux = new LinuxPC('linux-pc', 'PC', -200, 0);
  const windows = new WindowsPC('windows-pc', 'W', -200, 90);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  linux.powerOn(); windows.powerOn();

  new Cable('pc-sw').connect(linux.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('r-sw').connect(router.getPort('GigabitEthernet0/0')!, sw.getPorts()[1]);
  new Cable('sw-fw').connect(sw.getPorts()[2], fw.getPort('port1')!);
  new Cable('w-sw').connect(windows.getPorts()[0], sw.getPorts()[3]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 192.168.1.99 255.255.255.0',
    'set allowaccess ping https ssh http fgfm', 'next',
    'edit "port2"', 'set mode static', 'set ip 192.168.20.2 255.255.255.252',
    `set allowaccess ${allowOnPort2}`, 'next', 'end');
  run(sh, 'config system admin', 'edit "admin"',
    'set password "Secret123"', 'set accprofile "super_admin"', 'next', 'end');

  await runOn(router, ['enable', 'configure terminal', 'hostname Router2',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0',
    'no shutdown', 'exit',
    'ip route 192.168.20.0 255.255.255.252 192.168.1.99', 'end']);
  await runOn(linux, ['ip link set eth0 up', 'ip addr add 192.168.1.2/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(windows,
    ['netsh interface ip set address "Ethernet" static 192.168.1.3 255.255.255.0 192.168.1.1']);

  return { fw, linux, windows };
}

async function landsOnFirewallFromLinux(allowOnPort2: string, target: string): Promise<boolean> {
  const { linux } = await lab(allowOnPort2);
  const host = new LinuxTerminalSession('l', linux);
  await host.init?.();
  await sshLogin(host, `ssh admin@${target}`, 'Secret123');
  return host.foreground.getPrompt().includes('FW1');
}

async function landsOnFirewallFromWindows(allowOnPort2: string, target: string): Promise<boolean> {
  const { windows } = await lab(allowOnPort2);
  const host = new WindowsTerminalSession('w', windows);
  await host.init?.();
  await sshLogin(host, `ssh admin@${target}`, 'Secret123');
  return host.foreground.getPrompt().includes('FW1');
}

beforeEach(() => { Logger.reset(); });

describe('the interface owning the address decides, and both origins obey', () => {
  it('Linux is refused on an address whose interface allows only ping', async () => {
    expect(await landsOnFirewallFromLinux('ping', '192.168.20.2')).toBe(false);
  }, 30000);

  it('Windows is refused on that same address', async () => {
    expect(await landsOnFirewallFromWindows('ping', '192.168.20.2')).toBe(false);
  }, 30000);

  it('adding ssh to that interface opens it for Linux', async () => {
    expect(await landsOnFirewallFromLinux('ping ssh', '192.168.20.2')).toBe(true);
  }, 30000);

  it('adding ssh to that interface opens it for Windows', async () => {
    expect(await landsOnFirewallFromWindows('ping ssh', '192.168.20.2')).toBe(true);
  }, 30000);
});

describe('a legitimate access must keep working — WITNESSES', () => {
  it('Linux reaches the interface that allows ssh', async () => {
    expect(await landsOnFirewallFromLinux('ping', '192.168.1.99')).toBe(true);
  }, 30000);

  it('Windows reaches the interface that allows ssh', async () => {
    expect(await landsOnFirewallFromWindows('ping', '192.168.1.99')).toBe(true);
  }, 30000);
});
