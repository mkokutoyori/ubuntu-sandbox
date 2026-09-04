/**
 * Un segment TCP est enregistre UNE fois, et sur l'interface qui l'a
 * porte.
 *
 * Ecrit A L'AVEUGLE. Mesure faite en ecrivant `--scanflags` : le bus
 * publiait DEUX trames TCP la ou la capture rendait TROIS lignes. La
 * cause est une seconde ecriture — `TcpdumpCaptureProjection` recopie
 * dans `captureLog` chaque `tcp.segment.sent`/`received`, tandis que la
 * prise de port enregistre deja la trame REELLE. Les deux se disputent
 * la meme capture, et `makeTcpSegmentDedupSink` existe pour les
 * apparier apres coup : le rattrapage est le signe du defaut, pas sa
 * correction. Il suffit que la copie se trompe d'un champ — la cle
 * d'appariement porte les drapeaux — pour que les deux lignes sortent.
 *
 * La copie est de surcroit APPAUVRIE : elle ne porte ni fenetre ni
 * options, alors que la trame du fil les porte. Un `win 0` sur un
 * segment reel est une information fausse, et c'est ce que la ligne
 * survivante annonce des que c'est la copie qui gagne l'appariement.
 *
 * `TcpdumpCaptureProjection` avait pourtant une raison d'exister, et
 * elle en garde une : le BOUCLAGE. `TcpStack.shipSegment` remet la
 * segment en main propre quand la destination est locale (127.0.0.1 ou
 * une adresse de la machine) — aucune trame ne part, donc aucune prise
 * de port ne peut le voir, alors qu'un vrai `tcpdump -i lo` le voit.
 * C'est la moitie du travail que la projection doit garder, et la seule.
 *
 * D'ou la regle : la prise de port est le seul enregistreur de ce qui
 * traverse un cable, la projection le seul enregistreur de ce qui ne le
 * traverse pas, et l'evenement DIT lequel des deux — `shipSegment`
 * connait la reponse, il ne la publiait simplement pas.
 *
 * Consequence qui ne se devine pas : une connexion de bouclage ne doit
 * PAS paraitre sur `eth0`. Le repli de `captureLog` reetiquetait chaque
 * entree avec l'interface DEMANDEE, quelle qu'elle soit — son propre
 * commentaire le disait — donc `tcpdump -i lo` montrait le trafic
 * d'`eth0`, mesure et non suppose.
 *
 * Trouve en montant le laboratoire, et corrige avec : `nc` vers
 * 127.0.0.1 n'ouvrait AUCUNE connexion. Il demandait a `SocketTable`
 * si le port est lie et repondait de lui-meme — pas de segment, pas de
 * poignee de main, rien a capturer — alors que `TcpStack` sait remettre
 * un segment en main propre depuis que `ssh -L` en a eu besoin. Une
 * seconde reponse a « puis-je joindre 127.0.0.1:22 ? », et c'est la
 * copie qui ignorait le moteur.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * TROIS cas sur sept tombent contre l'etat d'avant. Les quatre autres
 * sont nommes plutot que laisses a decouvrir : les deux premiers
 * (« trois lignes, pas six » et « la fenetre reelle ») passaient parce
 * que `makeTcpSegmentDedupSink` faisait son travail de rattrapage tant
 * que la copie tombait juste — ils gardent qu'il n'est plus necessaire ;
 * le compte de lignes est une borne, donc vrai des deux cotes ; et
 * « pas de bouclage sur eth0 » passait pour une raison qui ne prouve
 * rien, `nc` n'emettant alors aucun segment du tout.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const c of commands) last = await d.executeCommand(c);
  return last;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function segment() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const serveur = new LinuxServer('linux-server', 'SERVEUR', 200, 0);
  client.powerOn(); serveur.powerOn();

  new Cable('c1').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(serveur.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

  await taper(client, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0');
  await taper(serveur, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0');
  await taper(serveur, 'sudo systemctl start ssh');
  await taper(client, 'ping -c 1 10.0.0.2');

  return { sw, client, serveur };
}

function lignes(sortie: string, motif: RegExp): string[] {
  return sortie.split('\n').filter((l) => motif.test(l));
}

describe('une trame du fil n est enregistree qu une fois', () => {
  it('la poignee de main sort trois lignes, pas six', async () => {
    const { client } = await segment();
    await taper(client, 'sudo tcpdump -i eth0 tcp -w /tmp/h.pcap &');

    await taper(client, 'nc -z 10.0.0.2 22');

    const vu = await taper(client, 'sudo tcpdump -r /tmp/h.pcap -nn');
    expect(lignes(vu, /10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.22: Flags \[S\]/)).toHaveLength(1);
    expect(lignes(vu, /10\.0\.0\.2\.22 > 10\.0\.0\.1\.\d+: Flags \[S\.\]/)).toHaveLength(1);
  });

  it('chaque ligne porte la fenetre REELLE du segment', async () => {
    const { client } = await segment();
    await taper(client, 'sudo tcpdump -i eth0 tcp -w /tmp/w.pcap &');

    await taper(client, 'nc -z 10.0.0.2 22');

    const vu = await taper(client, 'sudo tcpdump -r /tmp/w.pcap -nn');
    const syn = lignes(vu, /Flags \[S\]/)[0] ?? '';
    expect(syn).toMatch(/win [1-9]\d*/);
  });

  it('un segment SYN+FIN aussi, la ou l appariement echouait', async () => {
    const { client } = await segment();
    await taper(client, 'sudo tcpdump -i eth0 tcp -w /tmp/sf.pcap &');

    await taper(client, 'nmap -Pn --scanflags SYNFIN -p 22 10.0.0.2');

    const vu = await taper(client, 'sudo tcpdump -r /tmp/sf.pcap -nn');
    expect(lignes(vu, /Flags \[FS\]/)).toHaveLength(1);
    expect(lignes(vu, /Flags \[S\]/)).toHaveLength(0);
  });

  it('le compte des lignes suit le compte des trames du fil', async () => {
    const { client } = await segment();
    const bus = client.getBus();
    let trames = 0;
    const stop = bus.subscribe('port.frame.tx-requested', () => { trames++; });

    await taper(client, 'sudo tcpdump -i eth0 tcp -w /tmp/c.pcap &');
    await taper(client, 'nc -z 10.0.0.2 22');
    stop();

    const vu = await taper(client, 'sudo tcpdump -r /tmp/c.pcap -nn');
    const emises = lignes(vu, /10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.22/).length;
    expect(emises).toBeGreaterThan(0);
    expect(emises).toBeLessThanOrEqual(trames);
  });
});

describe('le bouclage se voit sur `lo` et NULLE PART ailleurs', () => {
  it('une connexion a 127.0.0.1 parait sur `lo`', async () => {
    const { serveur } = await segment();
    await taper(serveur, 'sudo tcpdump -i lo tcp -w /tmp/l.pcap &');

    await taper(serveur, 'nc -z 127.0.0.1 22');

    const vu = await taper(serveur, 'sudo tcpdump -r /tmp/l.pcap -nn');
    expect(vu).toMatch(/127\.0\.0\.1\.\d+ > 127\.0\.0\.1\.22: Flags \[S\]/);
  });

  it('elle ne parait PAS sur eth0', async () => {
    const { serveur } = await segment();
    await taper(serveur, 'sudo tcpdump -i eth0 tcp -w /tmp/e.pcap &');

    await taper(serveur, 'nc -z 127.0.0.1 22');

    const vu = await taper(serveur, 'sudo tcpdump -r /tmp/e.pcap -nn');
    expect(vu).not.toContain('127.0.0.1');
  });

  it('TEMOIN: une connexion du fil ne parait pas sur `lo`', async () => {
    const { client } = await segment();
    await taper(client, 'sudo tcpdump -i lo tcp -w /tmp/t.pcap &');

    await taper(client, 'nc -z 10.0.0.2 22');

    const vu = await taper(client, 'sudo tcpdump -r /tmp/t.pcap -nn');
    expect(vu).not.toContain('10.0.0.2.22');
  });
});
