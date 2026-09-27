/**
 * Sous `config vdom` / `edit <vdom>`, la FortiGate offre les commandes du
 * VDOM ; la portee globale n'offre pas celles qui touchent au reseau.
 *
 * Mesure de depart (4d805aa5) : sous `config vdom` / `edit customer`,
 * `execute ping` et `diagnose sys session stat` repondaient
 * « Unknown action 0 / Command fail. Return code -61 » et `?` ne
 * proposait que abort, config, end, get, next et show — seul
 * `execute enter` ouvrait le VDOM a ses commandes. A l'inverse,
 * `config global` offrait `execute ping`, `traceroute`, `telnet`, `ssh`
 * et `diagnose sniffer packet`, et le terminal lancait le ping en flux
 * sans demander a la coquille ou il se trouvait. Et un ping lance depuis
 * root atteignait un hote derriere port2, interface de customer : faute
 * de route dans root, la resolution retombait sur n'importe quelle
 * interface de la machine.
 *
 * Autorites :
 * - guide d'administration FortiGate-6000, FortiOS 7.6.1, « Packet
 *   sniffing for FPC and management board packets » : « To use this
 *   command, log into the management board and edit a VDOM » — la
 *   commande `diagnose sniffer packet` se tape apres `edit` d'un VDOM ;
 * - manuel FortiOS, « Troubleshooting Virtual Domains » : « When you are
 *   using VDOMs, you must be in a VDOM to access the diag sniffer
 *   command. At the global level, the command is not available. » ;
 * - communaute Fortinet, « cant find ping in execute (global) » : la
 *   liste capturee de `(global) # execute ?` ne contient ni ping ni
 *   ping-options, ni traceroute, ni telnet, ni ssh (elle contient
 *   backup, reboot, enter, erase-disk, factoryreset…), et la reponse :
 *   « all network related access functions like ping and traceroute are
 *   only available in the VDOMs itself ». Les seules commandes marquees
 *   VDOM sont celles que ces textes nomment ; `clear`, `dhcp` ou
 *   `interface`, absentes de la capture mais non expliquees par elle,
 *   restent ou elles etaient.
 *
 * Discrimination, mesuree sur le commit de base (4d805aa5) avec ce
 * fichier copie : 8 des 9 cas tombent. Passe des deux cotes le TEMOIN :
 * `execute enter customer` ouvrait deja le VDOM, et le ping y part par
 * port2 — sans quoi rien ici ne serait mesurable.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { openFortiConsole, runCommand } from './fortiConsoleHarness';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string[]> {
  const outputs: string[] = [];
  for (const command of commands) outputs.push(await device.executeCommand(command));
  return outputs;
}

const REFUSED = /Unknown action 0\nCommand fail\. Return code -61/;
const VDOM_ONLY_EXECUTE = ['ping', 'ping-options', 'ping6', 'ping6-options', 'ssh', 'telnet', 'traceroute', 'tracert6'];

async function tenantLab(): Promise<FortiGate> {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const host = new LinuxPC('linux-pc', 'H2');
  new Cable('fgt-h2').connect(firewall.getPort('port2')!, host.getPorts()[0]);
  await type(firewall, ['config system global', 'set vdom-mode multi-vdom', 'end',
    'config vdom', 'edit customer', 'next', 'end', 'config global',
    'config system interface', 'edit port2', 'set vdom customer', 'set ip 10.1.0.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end', 'end']);
  await type(host, ['sudo ip addr add 10.1.0.2/24 dev eth0', 'sudo ip link set eth0 up']);
  return firewall;
}

async function inVdom(firewall: FortiGate, vdom: string, command: string): Promise<string> {
  const [, , output] = await type(firewall, ['config vdom', `edit ${vdom}`, command, 'end']);
  return output;
}

async function inGlobal(firewall: FortiGate, command: string): Promise<string> {
  const [, output] = await type(firewall, ['config global', command, 'end']);
  return output;
}

function listed(help: string): string[] {
  return help.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
}

describe('config vdom / edit <vdom> opens the commands of that VDOM', () => {
  it('WITNESS: execute enter opens the VDOM, and its ping leaves by port2', async () => {
    const firewall = await tenantLab();
    const [, ping] = await type(firewall, ['execute enter customer', 'execute ping 10.1.0.2']);
    expect(ping).toContain('5 packets transmitted, 5 packets received');
  });

  it('execute ping runs inside config vdom / edit customer', async () => {
    const firewall = await tenantLab();
    expect(await inVdom(firewall, 'customer', 'execute ping 10.1.0.2'))
      .toContain('5 packets transmitted, 5 packets received');
  });

  it('and runs in the VDOM being edited: root does not own port2', async () => {
    const firewall = await tenantLab();
    const ping = await inVdom(firewall, 'root', 'execute ping 10.1.0.2');
    expect(ping).not.toMatch(REFUSED);
    expect(ping).not.toContain('5 packets received');
  });

  it('a ping from root never leaves by an interface of another VDOM', async () => {
    const firewall = await tenantLab();
    const [, ping] = await type(firewall, ['execute enter root', 'execute ping 10.1.0.2']);
    expect(ping).not.toContain('5 packets received');
  });

  it('diagnose answers inside the VDOM', async () => {
    const firewall = await tenantLab();
    expect(await inVdom(firewall, 'customer', 'diagnose sys session stat')).toMatch(/^misc info: session_count=/m);
  });

  it('? inside the VDOM offers diagnose and execute next to config, get and show', async () => {
    const firewall = await tenantLab();
    const offered = listed(await inVdom(firewall, 'customer', '?'));
    expect(offered).toEqual(expect.arrayContaining(['config', 'diagnose', 'execute', 'get', 'show', 'end', 'next']));
  });
});

describe('the global scope does not offer the network commands of a VDOM', () => {
  it('execute ping is refused in config global, and execute ? lists none of the network access commands', async () => {
    const firewall = await tenantLab();
    expect(await inGlobal(firewall, 'execute ping 10.1.0.2')).toMatch(REFUSED);
    const offered = listed(await inGlobal(firewall, 'execute ?'));
    expect(offered).toEqual(expect.arrayContaining(['backup', 'enter', 'reboot']));
    expect(offered.filter((name) => VDOM_ONLY_EXECUTE.includes(name))).toEqual([]);
  });

  it('diagnose sniffer packet is refused in config global and accepted in the VDOM', async () => {
    const firewall = await tenantLab();
    expect(await inGlobal(firewall, 'diagnose sniffer packet any none 4 1')).toMatch(REFUSED);
    expect(await inVdom(firewall, 'customer', 'diagnose sniffer packet any none 4 1')).not.toMatch(REFUSED);
  });

  it('the console does not stream a ping from the global scope', async () => {
    const firewall = await tenantLab();
    const session = await openFortiConsole(firewall);
    await runCommand(session, 'config global');
    const before = session.lines.length;
    await runCommand(session, 'execute ping 10.1.0.2');
    const printed = session.lines.slice(before).map((line) => line.text).join('\n');
    expect(printed).not.toContain('PING 10.1.0.2');
    expect(printed).toMatch(REFUSED);
  });
});
