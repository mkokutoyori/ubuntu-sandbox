/*
 * Le serveur DHCP d'un FortiGate (`config system dhcp server`) doit accepter
 * et SERVIR les attributs que le moteur partage porte deja : dns-server3, ntp-service et ntp-server1 a 3 (option 42), wins-server1 et 2 (option
 * 44), next-server et filename (options 66 et 67), config exclude-range,
 * config options (code, type hex|string|ip|fqdn), reserved-address action
 * (assign|block|reserved) et mac-acl-default-action (assign|block).
 *
 * L'AUTORITE : le schema FortiOS de `system dhcp server`, tel que le porte le
 * module `fortios_system_dhcp_server` de la collection Ansible de Fortinet
 * (noms, choix et descriptions) ; la reference CLI du depot
 * (official_docs/forti-cli-ref-60.txt, FortiOS 6.0.4, `system dhcp server`) ; RFC 2132 (options 6, 42, 44, 66, 67). La
 * documentation de Fortinet n'est pas joignable d'ici : les valeurs par
 * defaut (ntp-service specify, mac-acl-default-action assign, action
 * reserved) et l'encodage d'une option `fqdn` (etiquettes de la RFC 1035,
 * octet nul final) sont ceux d'un FortiGate reel de memoire, non sources.
 *
 * 12 des 17 cas tombent avant le correctif (git stash de src/network).
 * Passent des deux cotes : le TEMOIN du serveur sans attribut, celui de
 * l'adresse hors plage, l'adresse reservee servie (deja acquise), le client
 * non liste servi par le defaut assign (TEMOIN), et le client reserve en
 * `assign` sous un defaut `block`, qui passe avant parce que la CLI refusait
 * la ligne et que le defaut etait alors deja assign : il ne prouve que le
 * laboratoire. Chaque attribut etait refuse par la CLI ; le
 * laboratoire lit donc ce que le cable porte (Port.attachTap), et la CLI
 * (`Command fail`) pour les refus. Les TEMOINS, qui passent des deux cotes :
 * un serveur sans aucun de ces attributs n'offre ni option 42, 44, 66 ou 67,
 * et une plage exclue par la configuration historique (hors ip-range) reste
 * hors de l'offre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { resetCounters, MACAddress, ETHERTYPE_IPV4, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
}

function recordReplies(port: Port): DHCPPacket[] {
  const seen: DHCPPacket[] = [];
  port.attachTap(({ direction, frame }) => {
    if (direction !== 'in' || frame.etherType !== ETHERTYPE_IPV4) return;
    const udp = (frame.payload as IPv4Packet).payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.payload instanceof DHCPPacket && udp.payload.op === 2) seen.push(udp.payload);
  });
  return seen;
}

interface Lab { readonly fgt: FortiGate; readonly pc: LinuxPC; readonly replies: DHCPPacket[]; readonly mac: string }

type Server = readonly string[] | ((mac: string) => readonly string[]);

async function lab(extra: readonly string[] = [], serverLines: Server = []): Promise<Lab> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  const pc = new LinuxPC('linux-pc', 'PC1', -200, 0);
  new Cable('up').connect(sw.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('a').connect(pc.getPort('eth0')!, sw.getPort('eth1')!);
  await type(pc, ['ip link set eth0 up']);
  const mac = pc.getPort('eth0')!.getMAC().toString();
  const server = typeof serverLines === 'function' ? serverLines(mac) : serverLines;
  await type(fgt, [
    ...extra,
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"',
    'set default-gateway 192.168.10.1', 'set netmask 255.255.255.0',
    ...server,
    'config ip-range', 'edit 1',
    'set start-ip 192.168.10.100', 'set end-ip 192.168.10.110',
    'next', 'end', 'next', 'end',
  ]);
  return { fgt, pc, replies: recordReplies(pc.getPort('eth0')!), mac };
}

async function lease(pc: LinuxPC): Promise<string> {
  await pc.executeCommand('dhclient -r eth0');
  await pc.executeCommand('dhclient -v eth0');
  return /inet (\d+\.\d+\.\d+\.\d+)\//.exec(await pc.executeCommand('ip addr show eth0'))?.[1] ?? '';
}

const ack = (replies: DHCPPacket[]): DHCPPacket | undefined => replies.find(r => r.getMessageType() === 'DHCPACK');
const rawBody = (reply: DHCPPacket, code: number): number[] => Array.from(reply.getOption(code) as Uint8Array).slice(1);
const rawAddresses = (reply: DHCPPacket, code: number): string[] => {
  const body = rawBody(reply, code);
  const found: string[] = [];
  for (let i = 0; i + 4 <= body.length; i += 4) found.push(body.slice(i, i + 4).join('.'));
  return found;
};
const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]);

describe('serveur sans les attributs', () => {
  it('n offre ni option 42, 44, 66 ni 67 — WITNESS', async () => {
    const { pc, replies } = await lab();
    await lease(pc);
    const reply = ack(replies)!;
    for (const code of [42, 44, 66, 67]) expect(reply.getOption(code)).toBeUndefined();
  });
});

describe('DNS, NTP, WINS et amorcage', () => {
  it('dns-server1 a 3 sont tous offerts', async () => {
    const { pc, replies } = await lab([], [
      'set dns-server1 10.0.0.1', 'set dns-server2 10.0.0.2', 'set dns-server3 10.0.0.3']);
    await lease(pc);
    expect(asList(ack(replies)!.getOption(6))).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('ntp-service specify offre ntp-server1 a 3 en option 42', async () => {
    const { pc, replies } = await lab([], [
      'set ntp-service specify', 'set ntp-server1 10.5.5.1', 'set ntp-server2 10.5.5.2', 'set ntp-server3 10.5.5.3']);
    await lease(pc);
    expect(rawAddresses(ack(replies)!, 42)).toEqual(['10.5.5.1', '10.5.5.2', '10.5.5.3']);
  });

  it('ntp-service local offre l adresse de l interface du FortiGate', async () => {
    const { pc, replies } = await lab([], ['set ntp-service local']);
    await lease(pc);
    expect(rawAddresses(ack(replies)!, 42)).toEqual(['192.168.10.1']);
  });

  it('ntp-service default offre les serveurs NTP du systeme', async () => {
    const { pc, replies } = await lab([
      'config system ntp', 'set ntpsync enable', 'set type custom',
      'config ntpserver', 'edit 1', 'set server 10.9.9.9', 'next', 'end', 'end',
    ], ['set ntp-service default']);
    await lease(pc);
    expect(rawAddresses(ack(replies)!, 42)).toEqual(['10.9.9.9']);
  });

  it('wins-server1 et 2 sont offerts en option 44', async () => {
    const { pc, replies } = await lab([], ['set wins-server1 10.7.7.1', 'set wins-server2 10.7.7.2']);
    await lease(pc);
    expect(asList(ack(replies)!.getOption(44))).toEqual(['10.7.7.1', '10.7.7.2']);
  });

  it('next-server et filename sont offerts en options 66 et 67', async () => {
    const { pc, replies } = await lab([], ['set next-server 10.8.8.8', 'set filename "pxelinux.0"']);
    await lease(pc);
    expect(String(ack(replies)!.getOption(66))).toBe('10.8.8.8');
    expect(String(ack(replies)!.getOption(67))).toBe('pxelinux.0');
  });
});

describe('plages exclues', () => {
  it('config exclude-range retire des adresses de l offre', async () => {
    const { fgt, pc } = await lab([], [
      'config exclude-range', 'edit 1', 'set start-ip 192.168.10.100', 'set end-ip 192.168.10.104', 'next', 'end']);
    expect(await lease(pc)).toBe('192.168.10.105');
    expect(fgt).toBeTruthy();
  });

  it('une adresse hors de la plage configuree n est jamais offerte — WITNESS', async () => {
    const { pc } = await lab();
    const address = await lease(pc);
    expect(Number(address.split('.')[3])).toBeGreaterThanOrEqual(100);
    expect(Number(address.split('.')[3])).toBeLessThanOrEqual(110);
  });
});

describe('config options', () => {
  const option = (id: number, code: number, kind: string, value: string): string[] => [
    'config options', `edit ${id}`, `set code ${code}`, `set type ${kind}`,
    kind === 'ip' ? `set ip ${value}` : `set value "${value}"`, 'next', 'end'];

  it('type ip, string et hex portent l option demandee', async () => {
    const { pc, replies } = await lab([], [
      ...option(1, 224, 'ip', '10.6.6.6'), ...option(2, 225, 'string', 'hello'), ...option(3, 226, 'hex', 'c0a80a01')]);
    await lease(pc);
    const reply = ack(replies)!;
    expect(reply.getOption(224)).toBeDefined();
    expect(reply.getOption(225)).toBeDefined();
    expect(reply.getOption(226)).toBeDefined();
  });

  it('type fqdn encode le nom en etiquettes RFC 1035', async () => {
    const { pc, replies } = await lab([], option(1, 119, 'fqdn', 'lab.example'));
    await lease(pc);
    expect(rawBody(ack(replies)!, 119)).toEqual(Array.from('\u0003lab\u0007example\u0000').map(c => c.charCodeAt(0)));
  });

  it('un type ip sans adresse ne pose aucune option', async () => {
    const { pc, replies } = await lab([], ['config options', 'edit 1', 'set code 230', 'set type ip', 'next', 'end']);
    await lease(pc);
    expect(ack(replies)!.getOption(230)).toBeUndefined();
  });
});

describe('controle d acces par MAC', () => {
  const reserved = (mac: string, action: string): string[] => [
    'config reserved-address', 'edit 1', `set action ${action}`, `set mac ${mac}`, 'next', 'end'];

  it('mac-acl-default-action block refuse un client inconnu', async () => {
    const { pc } = await lab([], ['set mac-acl-default-action block']);
    expect(await lease(pc)).toBe('');
  });

  it('mac-acl-default-action block sert un client reserve en assign', async () => {
    const { pc } = await lab([], mac => ['set mac-acl-default-action block', ...reserved(mac, 'assign')]);
    expect(await lease(pc)).not.toBe('');
  });

  it('action block refuse le client malgre le defaut assign', async () => {
    const { pc } = await lab([], mac => reserved(mac, 'block'));
    expect(await lease(pc)).toBe('');
  });

  it('action reserved sert l adresse reservee', async () => {
    const { pc } = await lab([], mac => [
      'config reserved-address', 'edit 1', 'set ip 192.168.10.50', `set mac ${mac}`, 'next', 'end']);
    expect(await lease(pc)).toBe('192.168.10.50');
  });

  it('un client dont la MAC n est pas listee est servi par defaut assign — WITNESS', async () => {
    const { pc } = await lab([], reserved('02:aa:bb:cc:dd:ee', 'block'));
    expect(await lease(pc)).not.toBe('');
  });
});
