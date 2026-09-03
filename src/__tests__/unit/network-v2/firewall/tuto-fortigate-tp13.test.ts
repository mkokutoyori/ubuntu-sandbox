import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

async function laboratoireRouteur() {
  const r1 = new CiscoRouter('R1-EDGE', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const externe = new LinuxServer('linux-server', 'EXT', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, r1.getPort('GigabitEthernet0/1')!);
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/0')!, externe.getPort('eth0')!);

  await taper(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/0',
    'ip address 203.0.113.1 255.255.255.0', 'no shutdown', 'exit',
    'end',
  ]);
  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(externe, [
    'ip addr add 203.0.113.50/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 203.0.113.1',
  ]);
  await externe.executeCommand('systemctl start nginx');
  return { r1, pcLan, externe };
}

async function laboratoirePareFeu() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const externe = new LinuxServer('linux-server', 'EXT', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('wan').connect(fgt.getPort('port1')!, externe.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(externe, [
    'ip addr add 203.0.113.50/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 203.0.113.1',
  ]);
  await externe.executeCommand('systemctl start nginx');

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall policy', 'edit 1',
    'set name "LAN-vers-Internet"',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'set logtraffic all', 'next', 'end',
  ]);
  return { fgt, pcLan, externe };
}

describe('TP 13 — prouver l\'absence de memoire', () => {
  it('temoin : sans ACL la navigation fonctionne a travers R1', async () => {
    const { pcLan } = await laboratoireRouteur();
    expect(await pcLan.executeCommand('curl -sS http://203.0.113.50/'))
      .toContain('Welcome to nginx!');
  });

  it('etape 1-2 : une ACL stricte en entree CASSE le retour', async () => {
    const { r1, pcLan } = await laboratoireRouteur();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip access-list extended DEPUIS-INTERNET',
      'deny ip any any log', 'exit',
      'interface GigabitEthernet0/0',
      'ip access-group DEPUIS-INTERNET in', 'exit', 'end',
    ]);

    expect(await pcLan.executeCommand('curl -sS http://203.0.113.50/'))
      .not.toContain('Welcome to nginx!');
  });

  it('etape 2 : le compteur de l\'ACL COMPTE les reponses jetees', async () => {
    const { r1, pcLan } = await laboratoireRouteur();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip access-list extended DEPUIS-INTERNET',
      'deny ip any any log', 'exit',
      'interface GigabitEthernet0/0',
      'ip access-group DEPUIS-INTERNET in', 'exit', 'end',
    ]);
    await pcLan.executeCommand('curl -sS http://203.0.113.50/');

    const vue = await r1.executeCommand('show ip access-lists DEPUIS-INTERNET');
    expect(vue).toContain('deny ip any any');
    expect(vue).toMatch(/\([1-9]\d* match(es)?\)/);
  });

  it('etape 3 : ouvrir les ports hauts REPARE la navigation', async () => {
    const { r1, pcLan } = await laboratoireRouteur();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip access-list extended DEPUIS-INTERNET',
      'permit tcp any 192.168.0.0 0.0.255.255 gt 1023',
      'permit udp any 192.168.0.0 0.0.255.255 gt 1023',
      'deny ip any any log', 'exit',
      'interface GigabitEthernet0/0',
      'ip access-group DEPUIS-INTERNET in', 'exit', 'end',
    ]);

    expect(await pcLan.executeCommand('curl -sS http://203.0.113.50/'))
      .toContain('Welcome to nginx!');
  });

  it('etape 4 : et EXPOSE un service sur un port haut', async () => {
    const { r1, pcLan, externe } = await laboratoireRouteur();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip access-list extended DEPUIS-INTERNET',
      'permit tcp any 192.168.0.0 0.0.255.255 gt 1023',
      'permit udp any 192.168.0.0 0.0.255.255 gt 1023',
      'deny ip any any log', 'exit',
      'interface GigabitEthernet0/0',
      'ip access-group DEPUIS-INTERNET in', 'exit', 'end',
    ]);
    await pcLan.executeCommand('nc -l -p 8080 &');

    // `-Pn` parce que la decouverte d'hote EMET desormais ses sondes : la
    // liste de controle refuse l'echo ICMP et les connexions vers 80 et
    // 443, donc la cible est declaree en panne et aucun port n'est
    // balaye. C'est ce que fait le vrai nmap, et c'est precisement la
    // raison d'etre de `-Pn` ; le port haut, lui, reste ouvert.
    expect(await externe.executeCommand('nmap -Pn -p 8080 192.168.10.10'))
      .toMatch(/8080\/tcp\s+open/);
  });

  it('etape 5 : `established` repare la navigation ET protege le port haut',
    async () => {
      const { r1, pcLan, externe } = await laboratoireRouteur();
      await taper(r1, [
        'enable', 'configure terminal',
        'ip access-list extended DEPUIS-INTERNET',
        'permit tcp any 192.168.0.0 0.0.255.255 established',
        'deny ip any any log', 'exit',
        'interface GigabitEthernet0/0',
        'ip access-group DEPUIS-INTERNET in', 'exit', 'end',
      ]);
      await pcLan.executeCommand('nc -l -p 8080 &');

      expect(await pcLan.executeCommand('curl -sS http://203.0.113.50/'))
        .toContain('Welcome to nginx!');
      expect(await externe.executeCommand('nmap -p 8080 192.168.10.10'))
        .not.toMatch(/8080\/tcp\s+open/);
    });

  it('etape 6 : un balayage ACK TRAVERSE `established`', async () => {
    const { r1, externe } = await laboratoireRouteur();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip access-list extended DEPUIS-INTERNET',
      'permit tcp any 192.168.0.0 0.0.255.255 established',
      'deny ip any any log', 'exit',
      'interface GigabitEthernet0/0',
      'ip access-group DEPUIS-INTERNET in', 'exit', 'end',
    ]);

    // Meme raison qu'a l'etape 4 : la decouverte d'hote se fait au SYN et
    // a l'echo, que cette liste refuse ; c'est justement l'ACK qui la
    // traverse, et c'est ce que ce cas montre.
    const scan = await externe.executeCommand('nmap -Pn -sA -p 1-100 192.168.10.10');
    expect(scan).not.toMatch(/Unknown|not implemented|invalid/i);
    expect(scan).toMatch(/unfiltered/i);
  });

  it('etape 7 : le pare-feu laisse naviguer SANS aucune politique entrante',
    async () => {
      const { fgt, pcLan } = await laboratoirePareFeu();

      expect(await pcLan.executeCommand('curl -sS http://203.0.113.50/'))
        .toContain('Welcome to nginx!');
      expect(await fgt.executeCommand('show firewall policy'))
        .not.toMatch(/set srcintf "port1"/);
    });

  it('etape 7 : le pare-feu rend l\'hote INVISIBLE a la decouverte', async () => {
    const { externe } = await laboratoirePareFeu();

    const scan = await externe.executeCommand('nmap -sA -p 8080 192.168.10.10');
    expect(scan).toMatch(/Host seems down/);
    expect(scan).toMatch(/try -Pn/);
  });

  it('etape 7 : et il BLOQUE le balayage ACK, sans regle de plus', async () => {
    const { pcLan, externe } = await laboratoirePareFeu();
    await pcLan.executeCommand('nc -l -p 8080 &');

    const scan = await externe.executeCommand('nmap -sA -Pn -p 8080 192.168.10.10');
    expect(scan).toMatch(/8080\/tcp\s+filtered/);
    expect(scan).not.toMatch(/8080\/tcp\s+unfiltered/);
  });

  it('etape 7 : `debug flow` dit POURQUOI le paquet est jete', async () => {
    const { fgt, externe } = await laboratoirePareFeu();
    await taper(fgt, [
      'diagnose debug reset',
      'diagnose debug flow filter clear',
      'diagnose debug flow filter addr 192.168.10.10',
      'diagnose debug flow trace start 10',
      'diagnose debug enable',
    ]);
    await externe.executeCommand('nmap -sA -Pn -p 8080 192.168.10.10');

    const trace = await fgt.executeCommand('diagnose debug enable');
    expect(trace).toMatch(/no session matched, drop/);
    expect(trace).toMatch(/received a packet\(proto=6, 203\.0\.113\.50/);
  });

  it('le tableau du TP : le pare-feu n\'a demande AUCUNE regle de plus', async () => {
    const { fgt } = await laboratoirePareFeu();
    const regles = fgt.getPolicyStore().ordered().filter(r => !r.implicit);
    expect(regles).toHaveLength(1);
    expect(regles[0].from).toContain('port2');
  });
});
