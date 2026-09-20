/**
 * Suite de RELEVE (pas d'assertions de contrat) — `src/__tests__/debug/`.
 *
 * SECOND PASSAGE de `docs/AUDIT-SECURITE-INFRA.md`. Le premier audit
 * avait pose vingt controles de durcissement, les avait vus tous
 * acceptes, et en avait attaque six. Sa §5 nomme ceux qu'AUCUNE attaque
 * n'a eprouves et conclut : << chacun est un candidat serieux au defaut
 * du §6 >>. Ce banc les attaque.
 *
 * Ce qui se mesure ici n'est pas qu'une commande soit acceptee — elles
 * le sont toutes — mais qu'elle APPLIQUE.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const releve: string[] = [];
const note = (l: string) => { releve.push(l); console.log(l); };

async function cli(
  d: { executeCommand(c: string): Promise<string> }, lignes: string[],
): Promise<string> {
  let out = '';
  for (const c of lignes) out = await d.executeCommand(c);
  return out;
}

const perte = async (pc: LinuxPC, ip: string): Promise<string> =>
  (await pingOnSimulatedClock(pc, `ping -c 2 ${ip}`))
    .split('\n').filter((l) => /packet loss/.test(l)).join('').trim();

describe('second passage — les controles non attaques appliquent-ils ?', () => {
  it('uRPF : un paquet a source usurpee est-il rejete ?', async () => {
    const rt = new CiscoRouter('R', 0, 0);
    const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
    rt.powerOn(); pc.powerOn();
    new Cable('c').connect(pc.getPort('eth0')!, rt.getPort('GigabitEthernet0/0')!);

    await cli(rt, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']);
    await pc.executeCommand('ip addr add 10.0.0.10/24 dev eth0');
    await pc.executeCommand('ip link set eth0 up');

    note(`[uRPF-T] TEMOIN avant durcissement : ${await perte(pc, '10.0.0.1')}`);

    const pose = await cli(rt, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip verify unicast source reachable-via rx', 'end']);
    note(`[uRPF-1] la commande est acceptee : ${pose.trim() === '' ? 'oui (silence)' : JSON.stringify(pose.trim())}`);

    const conf = await rt.executeCommand('show running-config');
    note(`[uRPF-2] rendue par running-config : ${/ip verify unicast/.test(conf) ? 'oui' : 'NON'}`);

    note(`[uRPF-3] source LEGITIME apres durcissement : ${await perte(pc, '10.0.0.1')}`);

    const moteur = rt as unknown as {
      urpfRejects(inPort: string, pkt: unknown): boolean;
    };
    const paquet = (src: string) => ({
      version: 4, ihl: 5, tos: 0, totalLength: 40, identification: 1,
      flags: 0, fragmentOffset: 0, ttl: 64, protocol: 1,
      headerChecksum: 0,
      sourceIP: new IPAddress(src), destinationIP: new IPAddress('10.0.0.1'),
      payload: { type: 'icmp', icmpType: 'echo-request', code: 0 },
    }) as unknown;

    note(`[uRPF-4] source LEGITIME (10.0.0.10, sur le lien) rejetee ? ${
      moteur.urpfRejects('GigabitEthernet0/0', paquet('10.0.0.10')) ? 'OUI' : 'non'}`);
    note(`[uRPF-5] source USURPEE (203.0.113.9, aucune route) rejetee ? ${
      moteur.urpfRejects('GigabitEthernet0/0', paquet('203.0.113.9')) ? 'OUI' : 'NON'}`);
    expect(true).toBe(true);
  }, 180000);

  it('storm-control : une inondation de diffusion est-elle limitee ?', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    const a = new LinuxPC('linux-pc', 'PC-A', -150, -50);
    const b = new LinuxPC('linux-pc', 'PC-B', -150, 50);
    sw.powerOn(); a.powerOn(); b.powerOn();
    new Cable('c1').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await a.executeCommand('ip addr add 10.0.0.10/24 dev eth0');
    await a.executeCommand('ip link set eth0 up');
    await b.executeCommand('ip addr add 10.0.0.11/24 dev eth0');
    await b.executeCommand('ip link set eth0 up');

    const pose = await cli(sw, ['enable', 'configure terminal',
      'interface FastEthernet0/1',
      'storm-control broadcast level pps 10',
      'storm-control action shutdown', 'end']);
    note(`[storm-1] les commandes sont acceptees : ${pose.trim() === '' ? 'oui (silence)' : JSON.stringify(pose.trim())}`);

    note('[storm-1b] seuil pose : 10 paquets de diffusion par seconde, action shutdown');
    const scPort = sw.getPort('FastEthernet0/1')!.getStormControl();
    note(`[storm-1c] le port porte-t-il le reglage ? configure=${scPort.isConfigured()
      } action=${scPort.getAction()} seuil=${JSON.stringify(scPort.getThreshold('broadcast'))}`);
    const montre = await sw.executeCommand('show storm-control broadcast');
    note(`[storm-2] show storm-control rend : ${montre.split('\n').filter((l) => /Fa0\/1/.test(l)).join(' | ').trim() || '(rien)'}`);

    const conf = await sw.executeCommand('show running-config');
    note(`[storm-3] rendue par running-config : ${/storm-control broadcast/.test(conf) ? 'oui' : 'NON'}`);

    const portA = sw.getPort('FastEthernet0/1')!;
    const avant = portA.getCounters().framesIn;
    void avant;
    const portB = sw.getPort('FastEthernet0/2')!;
    const avantB = portB.getCounters().framesOut;
    const inondation = (n: number): void => {
      for (let i = 0; i < n; i++) {
        portA.receiveFrame({
          srcMAC: new MACAddress('aa:bb:cc:00:00:01'),
          dstMAC: MACAddress.broadcast(),
          etherType: 0x0800,
          payload: { type: 'test' },
        } as unknown as Parameters<typeof portA.receiveFrame>[0]);
      }
    };
    inondation(50);
    note(`[storm-3c] 50 diffusions injectees ; trames RELAYEES vers Fa0/2 : ${
      portB.getCounters().framesOut - avantB}`);
    note(`[storm-3d] trames supprimees par storm-control : ${
      portA.getStormControl().getSuppressedFrames()}`);
    const etat = await sw.executeCommand('show interfaces FastEthernet0/1 status');
    note(`[storm-5] etat du port apres l inondation : ${
      etat.split('\n').filter((l) => /Fa0\/1|err/i.test(l)).join(' | ').trim() || '(rien)'}`);
    note(`[storm-6] PC-B joint-il encore PC-A ? ${await perte(b, '10.0.0.10')}`);
    expect(true).toBe(true);
  }, 180000);

  it('storm-control sans action : l excedent tombe, le port reste up', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    const a = new LinuxPC('linux-pc', 'PC-A', -150, -50);
    const b = new LinuxPC('linux-pc', 'PC-B', -150, 50);
    sw.powerOn(); a.powerOn(); b.powerOn();
    new Cable('c1').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

    await cli(sw, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'storm-control broadcast level pps 10', 'end']);

    const portA = sw.getPort('FastEthernet0/1')!;
    const portB = sw.getPort('FastEthernet0/2')!;
    const avantB = portB.getCounters().framesOut;
    for (let i = 0; i < 40; i++) {
      portA.receiveFrame({
        srcMAC: new MACAddress('aa:bb:cc:00:00:01'),
        dstMAC: MACAddress.broadcast(),
        etherType: 0x0800,
        payload: { type: 'test' },
      } as unknown as Parameters<typeof portA.receiveFrame>[0]);
    }
    note(`[storm-7] 40 diffusions, seuil 10 pps, AUCUNE action : relayees vers Fa0/2 = ${
      portB.getCounters().framesOut - avantB}, supprimees = ${
      portA.getStormControl().getSuppressedFrames()}`);
    const etat = await sw.executeCommand('show interfaces FastEthernet0/1 status');
    note(`[storm-8] le port reste-t-il up ? ${
      etat.split('\n').filter((l) => /Fa0\/1/.test(l)).join(' | ').trim()}`);

    const portC = sw.getPort('FastEthernet0/1')!;
    portC.receiveFrame({
      srcMAC: new MACAddress('aa:bb:cc:00:00:01'),
      dstMAC: new MACAddress('aa:bb:cc:00:00:02'),
      etherType: 0x0800,
      payload: { type: 'test' },
    } as unknown as Parameters<typeof portC.receiveFrame>[0]);
    note(`[storm-9] une trame UNICAST connue passe-t-elle malgre la tempete de diffusion ? relayees = ${
      portB.getCounters().framesOut - avantB}`);
    expect(true).toBe(true);
  }, 180000);

  it('BPDU guard : une BPDU sur un port portfast err-disable-t-elle ?', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    const voyou = new CiscoSwitch('switch-cisco', 'ROGUE', 8, 0, 0);
    sw.powerOn(); voyou.powerOn();
    new Cable('x').connect(voyou.getPort('FastEthernet0/1')!, sw.getPort('FastEthernet0/3')!);

    await cli(sw, ['enable', 'configure terminal', 'interface FastEthernet0/3',
      'switchport mode access', 'spanning-tree portfast',
      'spanning-tree bpduguard enable', 'end']);
    note('[bpdu-1] portfast + bpduguard enable poses sur Fa0/3');

    const avant = await sw.executeCommand('show interfaces FastEthernet0/3 status');
    note(`[bpdu-2] etat AVANT la BPDU : ${
      avant.split('\n').filter((l) => /Fa0\/3/.test(l)).join(' | ').trim()}`);

    await cli(voyou, ['enable', 'configure terminal',
      'spanning-tree vlan 1 priority 0', 'end']);
    await new Promise((r) => setTimeout(r, 50));

    const apres = await sw.executeCommand('show interfaces FastEthernet0/3 status');
    note(`[bpdu-3] etat APRES la BPDU du voyou : ${
      apres.split('\n').filter((l) => /Fa0\/3/.test(l)).join(' | ').trim()}`);
    expect(true).toBe(true);
  }, 180000);

  it('SNMP : une requete v2c aboutit-elle quand SEUL v3 est declare ?', async () => {
    const rt = new CiscoRouter('R', 0, 0);
    const sonde = new CiscoRouter('SONDE', 100, 0);
    rt.powerOn(); sonde.powerOn();
    new Cable('s').connect(sonde.getPort('GigabitEthernet0/0')!, rt.getPort('GigabitEthernet0/0')!);
    await cli(rt, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']);
    await cli(sonde, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end']);

    const pose = await cli(rt, ['enable', 'configure terminal',
      'snmp-server group SECURE v3 priv',
      'snmp-server user admin SECURE v3 auth sha MotDePasse priv aes 128 Secret',
      'end']);
    note(`[snmp-1] v3 authPriv accepte : ${pose.trim() === '' ? 'oui (silence)' : JSON.stringify(pose.trim())}`);

    const conf = await rt.executeCommand('show running-config');
    note(`[snmp-2] rendu par running-config : ${
      conf.split('\n').filter((l) => /snmp-server (group|user)/.test(l)).join(' | ').trim() || 'RIEN'}`);
    note(`[snmp-3] communaute v2c declaree ? ${/snmp-server community/.test(conf) ? 'OUI' : 'non'}`);

    const reponse = await sonde.getSnmpAgent().get('10.0.0.1', 'public', ['1.3.6.1.2.1.1.5.0']);
    note(`[snmp-4] requete v2c community=public : ${
      reponse === null ? 'refusee (aucune donnee)' : 'ABOUTIT -> ' + JSON.stringify(reponse)}`);

    await cli(rt, ['enable', 'configure terminal',
      'snmp-server community public RO', 'end']);
    const avec = await sonde.getSnmpAgent().get('10.0.0.1', 'public', ['1.3.6.1.2.1.1.5.0']);
    note(`[snmp-5] TEMOIN — la meme requete APRES avoir declare la communaute : ${
      avec === null ? 'refusee' : 'aboutit -> ' + JSON.stringify(avec)}`);
    expect(true).toBe(true);
  }, 180000);

  it('ARP inspection : un ARP gratuit a liaison fausse est-il rejete ?', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    const victime = new LinuxPC('linux-pc', 'VICTIME', -150, -50);
    const pirate = new LinuxPC('linux-pc', 'PIRATE', -150, 50);
    sw.powerOn(); victime.powerOn(); pirate.powerOn();
    new Cable('v').connect(victime.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('p').connect(pirate.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await victime.executeCommand('ip addr add 10.0.0.10/24 dev eth0');
    await victime.executeCommand('ip link set eth0 up');
    await pirate.executeCommand('ip addr add 10.0.0.66/24 dev eth0');
    await pirate.executeCommand('ip link set eth0 up');

    const pose = await cli(sw, ['enable', 'configure terminal',
      'ip arp inspection vlan 1', 'end']);
    note(`[dai-1] ip arp inspection vlan 1 accepte : ${pose.trim() === '' ? 'oui (silence)' : JSON.stringify(pose.trim())}`);

    const avant = await sw.executeCommand('show ip arp inspection statistics');
    note(`[dai-2] statistiques AVANT :\n${avant}`);

    const sortieArping = await pirate.executeCommand(
      'arping -c 2 -U -s 10.0.0.10 -I eth0 10.0.0.10');
    note(`[dai-2b] arping brut : ${JSON.stringify(sortieArping.slice(0, 120))}`);

    const apres = await sw.executeCommand('show ip arp inspection statistics');
    note(`[dai-3] statistiques APRES l ARP gratuit usurpant 10.0.0.10 :\n${apres}`);
    const journal = await sw.executeCommand('show ip arp inspection log');
    note(`[dai-4] journal DAI :\n${journal}`);
    const tableVictime = await victime.executeCommand('ip neigh show');
    note(`[dai-5] table ARP de la VICTIME : ${JSON.stringify(tableVictime.trim())}`);
    expect(true).toBe(true);
  }, 180000);

  it('NTP authentifie : un serveur NON authentifie est-il refuse ?', async () => {
    const client = new CiscoRouter('CLIENT', 0, 0);
    const serveur = new CiscoRouter('SERVEUR', 100, 0);
    client.powerOn(); serveur.powerOn();
    new Cable('n').connect(client.getPort('GigabitEthernet0/0')!, serveur.getPort('GigabitEthernet0/0')!);
    await cli(client, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']);
    await cli(serveur, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.2 255.255.255.0', 'no shutdown',
      'ntp master 3', 'end']);

    await cli(client, ['enable', 'configure terminal',
      'ntp authenticate',
      'ntp authentication-key 1 md5 CleSecrete',
      'ntp trusted-key 1',
      'ntp server 10.0.0.2', 'end']);
    note('[ntp-1] client : ntp authenticate + cle 1 ; serveur 10.0.0.2 SANS key');

    await new Promise((r) => setTimeout(r, 100));
    const assoc = await client.executeCommand('show ntp associations');
    note(`[ntp-2] associations : ${assoc.split('\n').filter((l) => /10\.0\.0\.2/.test(l)).join(' | ').trim() || '(aucune ligne)'}`);
    const statut = await client.executeCommand('show ntp status');
    note(`[ntp-3] statut : ${statut.split('\n').filter((l) => /synchroniz/i.test(l)).join(' | ').trim()}`);

    const client2 = new CiscoRouter('CLIENT2', 0, 200);
    const serveur2 = new CiscoRouter('SERVEUR2', 100, 200);
    client2.powerOn(); serveur2.powerOn();
    new Cable('n2').connect(client2.getPort('GigabitEthernet0/0')!, serveur2.getPort('GigabitEthernet0/0')!);
    await cli(client2, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'end']);
    await cli(serveur2, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'ntp master 3', 'end']);
    await cli(client2, ['enable', 'configure terminal',
      'ntp authenticate',
      'ntp authentication-key 1 md5 CleSecrete',
      'ntp trusted-key 1',
      'ntp server 10.1.0.2 key 1', 'end']);
    await new Promise((r) => setTimeout(r, 100));
    const statut2 = await client2.executeCommand('show ntp status');
    note(`[ntp-4] cle EXIGEE des le depart, serveur SANS cle : ${
      statut2.split('\n').filter((l) => /synchroniz/i.test(l)).join(' | ').trim()}`);

    const client3 = new CiscoRouter('CLIENT3', 0, 400);
    const serveur3 = new CiscoRouter('SERVEUR3', 100, 400);
    client3.powerOn(); serveur3.powerOn();
    new Cable('n3').connect(client3.getPort('GigabitEthernet0/0')!, serveur3.getPort('GigabitEthernet0/0')!);
    await cli(client3, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.2.0.1 255.255.255.0', 'no shutdown', 'end']);
    await cli(serveur3, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.2.0.2 255.255.255.0', 'no shutdown',
      'ntp authentication-key 1 md5 CleSecrete', 'ntp trusted-key 1',
      'ntp master 3', 'end']);
    await cli(client3, ['enable', 'configure terminal',
      'ntp authenticate',
      'ntp authentication-key 1 md5 CleSecrete',
      'ntp trusted-key 1',
      'ntp server 10.2.0.2 key 1', 'end']);
    await new Promise((r) => setTimeout(r, 100));
    const statut3 = await client3.executeCommand('show ntp status');
    note(`[ntp-5] TEMOIN — cle exigee et serveur PORTANT la cle : ${
      statut3.split('\n').filter((l) => /synchroniz/i.test(l)).join(' | ').trim()}`);
    expect(true).toBe(true);
  }, 180000);
  it('VLAN natif : un saut de VLAN par double etiquetage aboutit-il ?', async () => {
    const monter = async (natif: number, vlanPirate: number) => {
      const sw1 = new CiscoSwitch('switch-cisco', `SW1-${natif}`, 24, 0, 0);
      const sw2 = new CiscoSwitch('switch-cisco', `SW2-${natif}`, 24, 200, 0);
      sw1.powerOn(); sw2.powerOn();
      new Cable(`t${natif}`).connect(
        sw1.getPort('FastEthernet0/24')!, sw2.getPort('FastEthernet0/24')!);
      for (const sw of [sw1, sw2]) {
        await cli(sw, ['enable', 'configure terminal',
          'vlan 10', 'exit', `vlan ${natif}`, 'exit', `vlan ${vlanPirate}`, 'exit',
          'interface FastEthernet0/24',
          'switchport trunk encapsulation dot1q', 'switchport mode trunk',
          `switchport trunk native vlan ${natif}`, 'end']);
      }
      await cli(sw1, ['enable', 'configure terminal', 'interface FastEthernet0/1',
        'switchport mode access', `switchport access vlan ${vlanPirate}`, 'end']);
      await cli(sw2, ['enable', 'configure terminal', 'interface FastEthernet0/1',
        'switchport mode access', 'switchport access vlan 10', 'end']);
      return { sw1, sw2 };
    };

    const injecter = (sw1: CiscoSwitch, mac: string, etiquettes: object): void => {
      sw1.getPort('FastEthernet0/1')!.receiveFrame({
        srcMAC: new MACAddress(mac),
        dstMAC: MACAddress.broadcast(),
        etherType: 0x0800,
        ...etiquettes,
        payload: { type: 'test' },
      } as unknown as Parameters<ReturnType<CiscoSwitch['getPort']>['receiveFrame']>[0]);
    };

    const doubleEtiquette = (exterieure: number) => ({
      outerDot1q: { tpid: 0x88a8, pcp: 0, dei: 0, vid: exterieure },
      dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: 10 },
    });

    const vlanAppris = async (sw2: CiscoSwitch, mac: string): Promise<string> => {
      const table = await sw2.executeCommand('show mac address-table');
      const motif = new RegExp(mac.replace(/:/g, '[.:]?'), 'i');
      const ligne = table.split('\n').find((l) => motif.test(l));
      return ligne ? ligne.trim() : '(rien appris sur SW2)';
    };

    const PIRATE = '02:00:00:00:de:ad';
    const SAGE = '02:00:00:00:be:ef';

    const nonDurci = await monter(1, 1);
    injecter(nonDurci.sw1, PIRATE, doubleEtiquette(1));
    note(`[hop-1] VLAN natif 1, pirate en VLAN 1 (= le natif), double etiquette 1/10 : ${
      await vlanAppris(nonDurci.sw2, PIRATE)}`);
    injecter(nonDurci.sw1, SAGE, {});
    note(`[hop-2] TEMOIN — meme port, trame SIMPLE sans double etiquette : ${
      await vlanAppris(nonDurci.sw2, SAGE)}`);

    const durci = await monter(999, 1);
    injecter(durci.sw1, PIRATE, doubleEtiquette(1));
    note(`[hop-3] MEME attaque, switchport trunk native vlan 999 (le pirate reste en VLAN 1) : ${
      await vlanAppris(durci.sw2, PIRATE)}`);
    injecter(durci.sw1, SAGE, {});
    note(`[hop-4] TEMOIN — trame simple du meme port, natif 999 : ${
      await vlanAppris(durci.sw2, SAGE)}`);

    const natifMalPose = await monter(999, 999);
    injecter(natifMalPose.sw1, PIRATE, doubleEtiquette(999));
    note(`[hop-5] natif 999 mais le pirate EST dans le VLAN natif : ${
      await vlanAppris(natifMalPose.sw2, PIRATE)}`);

    const tagNatif = await monter(1, 1);
    await cli(tagNatif.sw1, ['enable', 'configure terminal']);
    const poseTag = await tagNatif.sw1.executeCommand('vlan dot1q tag native');
    await cli(tagNatif.sw1, ['end']);
    note(`[hop-6] vlan dot1q tag native : ${
      poseTag.trim() === '' ? 'accepte (silence)' : JSON.stringify(poseTag.trim())}`);
    await cli(tagNatif.sw2, ['enable', 'configure terminal', 'vlan dot1q tag native', 'end']);
    const rcTag = await tagNatif.sw1.executeCommand('show running-config');
    note(`[hop-6b] rendu par running-config : ${
      rcTag.split('\n').filter((l) => /dot1q tag native/.test(l)).join(' | ').trim() || 'RIEN'}`);
    note(`[hop-6c] show vlan brief apres la commande : ${
      (await tagNatif.sw1.executeCommand('show vlan brief')).split('\n')
        .filter((l) => /^\s*\d+/.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' '))
        .join(' | ')}`);
    injecter(tagNatif.sw1, PIRATE, doubleEtiquette(1));
    note(`[hop-7] MEME attaque avec vlan dot1q tag native : ${
      await vlanAppris(tagNatif.sw2, PIRATE)}`);
    injecter(tagNatif.sw1, SAGE, {});
    note(`[hop-8] TEMOIN — trame simple, vlan dot1q tag native : ${
      await vlanAppris(tagNatif.sw2, SAGE)}`);

    expect(true).toBe(true);
  }, 180000);
  it('AAA : un serveur injoignable SANS repli local laisse-t-il entrer en SSH ?', async () => {
    const touche = (k: string): KeyEvent =>
      ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    const souffle = () => new Promise<void>((r) => setTimeout(r, 25));
    const ouvrirSession = async (
      hote: TerminalSession, ligne: string, motDePasse: string,
    ): Promise<void> => {
      hote.setInput(ligne);
      hote.handleKey(touche('Enter'));
      for (let i = 0; i < 120 && hote.currentInputMode.type !== 'password'; i++) await souffle();
      if (hote.currentInputMode.type === 'password') {
        hote.setPasswordBuf(motDePasse);
        hote.handleKey(touche('Enter'));
      }
      for (let i = 0; i < 600 && !entre(hote) && !refuse(hote); i++) await souffle();
    };
    const refuse = (t: TerminalSession): boolean =>
      t.lines.some((l) => /Permission denied|Authentication failed|Login invalid/i.test(l.text));
    const entre = (t: TerminalSession): boolean =>
      t.lines.some((l) => /^NAS[#>]/.test(l.text.trim()));
    const dernieres = (t: TerminalSession): string =>
      t.lines.slice(-6).map((l) => l.text).filter((x) => x.trim() !== '').join(' | ');

    const monter = async (methodes: string | null) => {
      const rt = new CiscoRouter('NAS', 0, 0);
      const pc = new LinuxPC('linux-pc', 'POSTE', -150, 0);
      rt.powerOn(); pc.powerOn();
      new Cable(`a${String(methodes).length}`).connect(
        pc.getPort('eth0')!, rt.getPort('GigabitEthernet0/0')!);
      await pc.executeCommand('ip addr add 10.0.0.10/24 dev eth0');
      await pc.executeCommand('ip link set eth0 up');
      await cli(rt, ['enable', 'configure terminal',
        'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
        'no shutdown', 'exit',
        'username local15 privilege 15 secret Local@2025',
        'enable secret Enable@2025',
        'ip domain-name labo.local',
        'crypto key generate rsa modulus 2048',
        'ip ssh version 2']);
      if (methodes === null) {
        await cli(rt, ['line vty 0 4', 'login local', 'transport input ssh', 'end']);
      } else {
        await cli(rt, ['aaa new-model',
          'radius server INJOIGNABLE',
          'address ipv4 192.0.2.99 auth-port 1812 acct-port 1813',
          'key Radius@2025',
          'exit',
          'aaa group server radius GRP',
          'server name INJOIGNABLE',
          'exit',
          'radius-server timeout 1', 'radius-server retransmit 0',
          `aaa authentication login default ${methodes}`,
          'line vty 0 4', 'login authentication default',
          'transport input ssh', 'end']);
      }
      return { rt, pc };
    };

    const sansAaa = await monter(null);
    const poste0 = new LinuxTerminalSession('h0', sansAaa.pc);
    await poste0.init?.();
    await ouvrirSession(poste0, 'ssh local15@10.0.0.1', 'Local@2025');
    note(`[aaa-0] TEMOIN DU LABO — SSH, login local, AUCUN aaa : ${
      entre(poste0) ? 'entre' : 'REFUSE (le labo ne prouve rien)'} | ${dernieres(poste0)}`);

    const aaaLocal = await monter('local');
    const posteL = new LinuxTerminalSession('hL', aaaLocal.pc);
    await posteL.init?.();
    await ouvrirSession(posteL, 'ssh local15@10.0.0.1', 'Local@2025');
    note(`[aaa-0b] TEMOIN — aaa new-model + aaa authentication login default LOCAL (aucun serveur) : ${
      entre(posteL) ? 'entre' : 'REFUSE'} | ${dernieres(posteL)}`);

    const sansRepli = await monter('group GRP');
    const rc = await sansRepli.rt.executeCommand('show running-config');
    note(`[aaa-1] pose : ${rc.split('\n').filter((l) => /aaa (new-model|authentication|group)/.test(l))
      .map((l) => l.trim()).join(' | ')}`);

    const poste = new LinuxTerminalSession('h1', sansRepli.pc);
    await poste.init?.();
    await ouvrirSession(poste, 'ssh local15@10.0.0.1', 'Local@2025');
    note(`[aaa-2] SSH avec le compte LOCAL, methode unique group GRP (serveur injoignable) : ${
      dernieres(poste)}`);
    note(`[aaa-3] la session a-t-elle bascule sur le routeur ? ${
      entre(poste) ? 'OUI — AAA CONTOURNE' : 'non'}`);

    const avecRepli = await monter('group GRP local');
    const poste2 = new LinuxTerminalSession('h2', avecRepli.pc);
    await poste2.init?.();
    await ouvrirSession(poste2, 'ssh local15@10.0.0.1', 'Local@2025');
    note(`[aaa-4] TEMOIN — meme SSH avec group GRP local (repli autorise) : ${
      entre(poste2) ? 'entre' : 'refuse'} | ${dernieres(poste2)}`);

    const poste3 = new LinuxTerminalSession('h3', avecRepli.pc);
    await poste3.init?.();
    await ouvrirSession(poste3, 'ssh local15@10.0.0.1', 'MauvaisMotDePasse');
    note(`[aaa-5] TEMOIN — mauvais mot de passe, repli autorise : ${
      entre(poste3) ? 'ENTRE (faux positif)' : 'refuse'} | ${dernieres(poste3)}`);
    expect(true).toBe(true);
  }, 180000);
});
