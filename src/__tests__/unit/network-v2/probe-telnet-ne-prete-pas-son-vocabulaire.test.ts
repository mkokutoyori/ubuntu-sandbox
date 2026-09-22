/**
 * Une CLI vendeur pretait SON vocabulaire a la machine qu'on visitait en
 * telnet.
 *
 * MESURE DE DEPART. Un Cisco ouvre un telnet vers un FortiGate. L'invite
 * affiche `FGT # `. On tape, et on compare a ce que le pare-feu repond
 * vraiment :
 *
 *   mot tape        le FORTIGATE dit           le CISCO rendait
 *   `conf`          ["config"]                 "configure "
 *   `show ver`      []                         "show version "
 *   `get sys int`   ["get system interface"]   inchange
 *
 * La ligne du milieu est la plus grave, et c'est elle qui donne son sujet
 * a ce fichier : la completion ne se TAIT pas, elle MENT de facon
 * plausible. L'operateur voit `configure`, le tape, et FortiOS le refuse
 * puisqu'il attend `config`. Une absence de reponse aurait ete moins
 * couteuse qu'une reponse fausse.
 *
 * Le `?` faisait pire encore. Sous l'invite `FGT # `, un `show ?`
 * imprimait les quatre-vingts entrees du `show` de IOS — `bgp`, `eigrp`,
 * `dmvpn`, `glbp`, `standby` — et la ligne d'echo portait `R1#show ?`,
 * l'invite de la MAUVAISE machine sous le prompt de la bonne.
 *
 * POURQUOI. `CLITerminalSession.onTab` interroge `cliDevice.
 * cliTabCandidates` et `showInlineHelp` interroge `cliDevice.cliHelp` :
 * l'equipement LOCAL, sans jamais regarder si une session distante est
 * ouverte. Le terminal Linux, lui, ne proposait rien du tout dans le meme
 * cas — les deux origines se contredisaient donc sur la meme touche.
 *
 * CE QUE LE TRANSPORT PERMET, mesure plutot que suppose. Sur un vrai
 * telnet, Tab et `?` fonctionnent parce que les TOUCHES circulent et que
 * c'est le distant qui edite la ligne. Ce sous-shell-ci est un tuyau de
 * LIGNES (`client.send(line)` puis lecture de ce qui revient), donc
 * aucune touche n'atteint le distant avant le retour chariot :
 *
 *   - Tab est hors de portee. Aucune ligne ne signifie « complete ceci »,
 *     et l'inventer serait inventer une extension de telnet.
 *   - `?` l'est, mais autrement : sur un client ligne a ligne c'est un
 *     CARACTERE ORDINAIRE. On tape `show ?`, on valide, et le distant
 *     repond son aide a lui. C'est mesure ici, et c'est ce que le
 *     correctif rend possible en cessant d'intercepter la touche.
 *
 * Le correctif se resume donc a NE PLUS REPONDRE A LA PLACE DU DISTANT :
 * tant qu'une session telnet est ouverte, la CLI vendeur n'offre ni ses
 * candidats, ni son aide, ni sa suggestion fantome. Silence la ou elle ne
 * sait pas, et la ligne passe au distant la ou il sait.
 *
 * DISCRIMINATION (`git stash push -- src/terminal`) : 3 des 7 cas
 * tombent. Les QUATRE temoins sont nommes avec leur raison, et deux
 * d'entre eux sont l'objet meme du lot — la console locale du Cisco DOIT
 * continuer de completer `conf` en `configure`, et le pare-feu DOIT
 * continuer de repondre a une ligne qu'on lui envoie. Sans eux, couper la
 * completion partout passerait la sonde.
 *
 * UN MOT MAL CHOISI NE MESURE RIEN. La premiere mesure de ce defaut
 * utilisait `get sys int`, et elle ne montrait rien : le Cisco n'a pas
 * `get`, donc zero candidat, donc rien ne bougeait. Le mot qui tranche
 * est celui que LES DEUX vocabulaires connaissent — `conf` — parce que
 * c'est la que la mauvaise reponse a l'air d'une bonne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoTerminalSession } from '@/terminal/sessions';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
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

async function typeLine(host: TerminalSession, line: string): Promise<void> {
  const fg = host.foreground;
  fg.setInput(line);
  fg.setInputBuf(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 14; i++) await tick();
}

async function tabOn(host: TerminalSession, line: string): Promise<string> {
  host.foreground.setInput(line);
  host.foreground.setInputBuf(line);
  host.handleKey(key('Tab'));
  for (let i = 0; i < 12; i++) await tick();
  return host.foreground.input;
}

function transcript(host: TerminalSession): string {
  return host.lines.map((l) => l.text).join('\n');
}

async function lab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const linux = new LinuxPC('linux-pc', 'PC', -150, 0);
  const cisco = new CiscoRouter('R1', 0, 0);
  linux.powerOn();

  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('a').connect(linux.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('b').connect(sw.getPorts()[1], fw.getPort('port1')!);
  new Cable('c').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPorts()[2]);

  run(sh, 'config system interface', 'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping telnet', 'next', 'end');
  run(sh, 'config system admin', 'edit "admin"',
    'set password "Secret123"', 'set accprofile "super_admin"', 'next', 'end');
  await runOn(linux, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);
  await runOn(cisco, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.30 255.255.255.0',
    'no shutdown', 'exit', 'end']);

  return { fw, linux, cisco };
}

async function ciscoOnTelnet(cisco: CiscoRouter): Promise<CiscoTerminalSession> {
  const host = new CiscoTerminalSession('c', cisco);
  await host.init?.();
  await typeLine(host, 'enable');
  await typeLine(host, 'telnet 192.168.1.1');
  await typeLine(host, 'admin');
  await typeLine(host, 'Secret123');
  return host;
}

beforeEach(() => { Logger.reset(); });

describe('the two machines really do disagree on these words', () => {
  it('the firewall says `config` where IOS says `configure` — WITNESS', async () => {
    const { fw, cisco } = await lab();
    expect(fw.cliTabCandidates('conf')).toEqual(['config']);
    expect(cisco.cliTabCandidates('conf')).toContain('configure');
  }, 30000);

  it('on its own console the router still completes its own words — WITNESS', async () => {
    const { cisco } = await lab();
    const host = new CiscoTerminalSession('local', cisco);
    await host.init?.();
    await typeLine(host, 'enable');

    expect(await tabOn(host, 'conf')).toBe('configure ');
  }, 30000);
});

describe('over telnet, the vendor CLI stops answering for the remote', () => {
  it('a word both vocabularies know is left alone', async () => {
    const { cisco } = await lab();
    const host = await ciscoOnTelnet(cisco);

    expect(await tabOn(host, 'conf')).toBe('conf');
  }, 30000);

  it('a word only IOS knows is not offered either', async () => {
    const { cisco } = await lab();
    const host = await ciscoOnTelnet(cisco);

    expect(await tabOn(host, 'show ver')).toBe('show ver');
  }, 30000);

  it('`?` no longer prints the local vocabulary', async () => {
    const { cisco } = await lab();
    const host = await ciscoOnTelnet(cisco);

    host.foreground.setInput('show ');
    host.foreground.setInputBuf('show ');
    host.handleKey(key('?'));
    for (let i = 0; i < 12; i++) await tick();

    expect(transcript(host)).not.toContain('Display DMVPN status');
    expect(transcript(host)).not.toContain('R1#show ?');
  }, 30000);
});

describe('both origins now say the same thing', () => {
  it('a Linux terminal on the same telnet session offers nothing either — WITNESS', async () => {
    const { linux } = await lab();
    const host = new LinuxTerminalSession('h', linux);
    await host.init?.();
    await typeLine(host, 'telnet 192.168.1.1');
    await typeLine(host, 'admin');
    await typeLine(host, 'Secret123');

    host.foreground.setInputBuf('conf');
    host.handleKey(key('Tab'));
    for (let i = 0; i < 12; i++) await tick();
    expect(host.foreground.getInputBuf()).toBe('conf');
  }, 30000);
});

describe('what the remote can answer, it still answers — WITNESS', () => {
  it('a line ending in `?` reaches the firewall and prints its help', async () => {
    const { cisco } = await lab();
    const host = await ciscoOnTelnet(cisco);

    await typeLine(host, 'show ?');

    expect(transcript(host)).toContain('Configure webfilter.');
  }, 30000);
});
