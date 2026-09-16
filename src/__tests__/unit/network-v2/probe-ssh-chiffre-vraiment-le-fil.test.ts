/**
 * Sonde — ce qu'un renifleur lit pendant une session SSH.
 *
 * Mesure AVANT correction, sur ce laboratoire : la session SSH sur le fil
 * ecrivait ses messages en JSON EN CLAIR. Un `tcpdump` place sur le port
 * SPAN d'un commutateur lisait donc mot pour mot
 * `{"op":"auth","method":"password","password":"ssh-secret-PW!"}' puis la
 * commande distante. TROIS cas sur six tombent avant la correction :
 *
 *   - le mot de passe n'apparait pas dans la capture              TOMBE
 *   - la commande distante n'apparait pas dans la capture         TOMBE
 *   - aucun message d'authentification ne traverse en clair       TOMBE
 *
 * Les TROIS cas qui passent des AVANT la correction, et pourquoi ils sont
 * ecrits quand meme :
 *
 *   - `SSH-2.0` reste visible : TEMOIN. Un vrai SSH echange ses versions
 *     en clair avant tout chiffrement, et une capture ou plus rien
 *     n'apparaitrait ne prouverait que la panne du laboratoire.
 *   - telnet expose son mot de passe dans le meme laboratoire : TEMOIN.
 *     Sans lui, une capture vide ferait passer les trois premiers cas
 *     sans rien demontrer.
 *   - `whoami' rend toujours `alice' : NON-REGRESSION. Le chiffrement ne
 *     doit pas casser la session qu'il protege.
 *
 * Limite mesuree et NON fermee ici : la poignee de main initiale reste
 * `{"op":"hello",...}' en clair, la ou un vrai SSH envoie la seule ligne
 * `SSH-2.0-OpenSSH_...'. Le chiffrement commence apres cet echange, donc
 * aucun justificatif n'y figure, mais le fil ne ressemble pas encore a du
 * SSH a cet instant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const SECRET = 'ssh-secret-PW!';

interface Lab {
  client: LinuxPC;
  server: LinuxServer;
  sniffer: LinuxPC;
  sw: CiscoSwitch;
}

function buildLab(): Lab {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SERVER');
  const sniffer = new LinuxPC('linux-pc', 'SNIFFER');

  client.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.20'), MASK);
  sniffer.getPort('eth0')!.configureIP(new IPAddress('10.0.0.99'), MASK);

  new Cable('cab-client').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('cab-server').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('cab-sniffer').connect(sniffer.getPort('eth0')!, sw.getPort('FastEthernet0/8')!);

  return { client, server, sniffer, sw };
}

async function armSpan(sw: CiscoSwitch): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('monitor session 1 source interface FastEthernet0/1');
  await sw.executeCommand('monitor session 1 destination interface FastEthernet0/8');
  await sw.executeCommand('end');
}

async function sshCapture(command = 'cat /etc/shadow'): Promise<{ capture: string; output: string }> {
  const { client, server, sniffer, sw } = buildLab();
  await armSpan(sw);
  await server.executeCommand('useradd alice');
  await server.executeCommand(`echo "alice:${SECRET}" | chpasswd`);
  await server.executeCommand('systemctl start ssh');
  await sniffer.executeCommand('tcpdump -i eth0 -w /tmp/ssh.pcap &');
  const output = await client.executeCommand(
    `ssh -o StrictHostKeyChecking=no alice@10.0.0.20 "${command}"`,
    `${SECRET}\n`,
  );
  return { capture: await sniffer.executeCommand('tcpdump -r /tmp/ssh.pcap -A'), output };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('une session SSH ne laisse rien de lisible sur le fil', () => {
  it('le mot de passe n\'apparait pas dans la capture', async () => {
    const { capture } = await sshCapture();
    expect(capture).not.toContain(SECRET);
  }, 30000);

  it('la commande distante n\'apparait pas dans la capture', async () => {
    const { capture } = await sshCapture();
    expect(capture).not.toContain('cat /etc/shadow');
  }, 30000);

  it('aucun justificatif ni message d\'authentification ne traverse le fil en clair', async () => {
    const { capture } = await sshCapture();
    expect(capture).not.toContain('"password":');
    expect(capture).not.toContain('"method":"password"');
    expect(capture).not.toContain('"op":"auth"');
    expect(capture).not.toContain('"op":"exec"');
  }, 30000);

  it('temoin : la version du protocole reste en clair, comme dans un vrai SSH', async () => {
    const { capture } = await sshCapture();
    expect(capture).toMatch(/SSH-2\.0/);
  }, 30000);

  it('non-regression : la commande distante rend toujours son resultat', async () => {
    const { output } = await sshCapture('whoami');
    expect(output).toMatch(/^alice\s*$/m);
  }, 30000);

  it('temoin du laboratoire : telnet, lui, expose son mot de passe', async () => {
    const { client, server, sniffer, sw } = buildLab();
    await armSpan(sw);
    await server.executeCommand('useradd bob');
    await server.executeCommand('echo "bob:telnet-cleartext" | chpasswd');
    await server.executeCommand('systemctl start telnet');
    await sniffer.executeCommand('tcpdump -i eth0 -w /tmp/telnet.pcap &');
    await client.executeCommand('telnet 10.0.0.20', 'bob\ntelnet-cleartext\nls /etc\nexit\n');
    const capture = await sniffer.executeCommand('tcpdump -r /tmp/telnet.pcap -A');
    expect(capture).toContain('telnet-cleartext');
  }, 30000);
});
