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
});
