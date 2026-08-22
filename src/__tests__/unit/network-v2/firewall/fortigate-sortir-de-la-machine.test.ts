import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { verifyIPv4Checksum } from '@/network/core/types';
import { buildEchoRequest } from '../../../../network/icmp/IcmpEcho';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { openFortiConsole, runCommand, answerSecret } from './fortiConsoleHarness';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.clear();
});

const seen = (s: { lines: { text: string }[] }) => s.lines.map(l => l.text).join('\n');
const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

async function voisinDirect() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
  await run(pc, 'ip link set eth0 up');
  await run(pc, 'sudo useradd -m operateur');
  await run(pc, 'sudo bash -c \'echo "operateur:Lab2026" | chpasswd\'');
  for (const c of ['config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping ssh telnet',
    'next', 'end']) await run(fgt, c);
  return { fgt, pc };
}

describe('un paquet fabrique porte la somme de controle de CE qu il transporte', () => {
  it('un TTL demande est couvert par la somme de controle', () => {
    const packet = buildEchoRequest('10.0.0.1', '10.0.0.2', 7, 1, 56, 1);
    expect(packet.ttl).toBe(1);
    expect(verifyIPv4Checksum(packet)).toBe(true);
  });

  it('le defaut reste 64, comme avant', () => {
    const packet = buildEchoRequest('10.0.0.1', '10.0.0.2', 7, 1);
    expect(packet.ttl).toBe(64);
    expect(verifyIPv4Checksum(packet)).toBe(true);
  });
});

describe('`execute traceroute` TROUVE ce que `execute ping` atteint', () => {
  it('un voisin direct repond au premier saut', async () => {
    const { fgt } = await voisinDirect();
    const temoin = await run(fgt, 'execute ping 192.168.10.10');
    expect(temoin).toContain(', 0% packet loss');

    const vu = await run(fgt, 'execute traceroute 192.168.10.10');
    expect(vu).toContain(' 1  192.168.10.10');
    expect(vu).not.toContain(' 2  ');
  });

  it('la trace s arrete a la cible, elle ne va pas jusqu a 32', async () => {
    const { fgt } = await voisinDirect();
    const vu = await run(fgt, 'execute traceroute 192.168.10.10');
    expect(vu.split('\n').length).toBeLessThan(4);
  });

  it('une cible injoignable rend bien des etoiles', async () => {
    const { fgt } = await voisinDirect();
    const vu = await run(fgt, 'execute traceroute 192.168.10.99');
    expect(vu).toContain('* * *');
  });

  it('un routeur intermediaire est NOMME par son ICMP time-exceeded', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const rtr = new CiscoRouter('R1', -200, 0);
    const pc = new LinuxPC('linux-pc', 'PC', -400, 0);
    new Cable('a').connect(fgt.getPort('port2')!, rtr.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(rtr.getPort('GigabitEthernet0/1')!, pc.getPort('eth0')!);

    for (const c of ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'end']) await run(rtr, c);
    await run(pc, 'ip addr add 10.0.1.10/24 dev eth0');
    await run(pc, 'ip link set eth0 up');
    await run(pc, 'ip route add default via 10.0.1.1');
    for (const c of ['config system interface', 'edit port2', 'set mode static',
      'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
      'config router static', 'edit 1', 'set dst 10.0.1.0 255.255.255.0',
      'set gateway 10.0.0.2', 'set device port2', 'next', 'end']) await run(fgt, c);

    const vu = await run(fgt, 'execute traceroute 10.0.1.10');
    expect(vu).toContain(' 1  10.0.0.2');
    expect(vu).toContain(' 2  10.0.1.10');
  });
});

describe('la console SORT de la machine : `execute ssh` et `execute telnet`', () => {
  it('`execute ssh` n est plus une action inconnue', async () => {
    const { fgt } = await voisinDirect();
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute ssh admin@192.168.10.10');
    expect(seen(s)).not.toContain('unknown action "ssh"');
  });

  it('`execute ssh` bascule en saisie masquee, comme un vrai client', async () => {
    const { fgt } = await voisinDirect();
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute ssh operateur@192.168.10.10');
    expect(s.currentInputMode.type).toBe('password');
    expect(seen(s)).not.toContain('Permission denied');
  });

  it('le mot de passe accepte ouvre une session SUR la machine distante', async () => {
    const { fgt } = await voisinDirect();
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute ssh operateur@192.168.10.10');
    await answerSecret(s, 'Lab2026');

    const avant = s.lines.length;
    await runCommand(s, 'hostname');
    const repondu = s.lines.slice(avant).map(l => l.text).join('\n');
    expect(repondu).toContain('linux-pc');
    expect(repondu).not.toContain('FGT-01 #');
  });

  it('`execute telnet` n est plus une action inconnue', async () => {
    const { fgt } = await voisinDirect();
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute telnet 192.168.10.10');
    expect(seen(s)).not.toContain('unknown action "telnet"');
  });

  it('les deux figurent dans `execute ?`', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const vu = await run(fgt, 'execute ?');
    expect(vu).toContain('ssh');
    expect(vu).toContain('telnet');
  });

  it('hors console, le refus NOMME la brique manquante', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const vu = await run(fgt, 'execute ssh operateur@192.168.10.10');
    expect(vu).not.toContain('unknown action');
    expect(vu).toContain('interactive console');
  });

  it('sans destination, la commande dit ce qui manque', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const vu = await run(fgt, 'execute telnet');
    expect(vu).not.toContain('unknown action');
    expect(vu.toLowerCase()).toContain('destination');
  });

  it('un `execute` d autre chose reste refuse', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const vu = await run(fgt, 'execute zorglub');
    expect(vu).toContain('Command fail');
  });
});
