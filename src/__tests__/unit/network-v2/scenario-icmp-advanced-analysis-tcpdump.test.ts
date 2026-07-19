/**
 * Scénario 9 — Analyse des messages ICMP avancés avec tcpdump natif.
 *
 * Le traceroute de cette plateforme détermine les sauts via de vrais échos
 * ICMP à TTL croissant (pas des sondes UDP comme le traceroute Linux réel) ;
 * il émet en plus, pour rester wire-réaliste, de vraies sondes UDP sur
 * 33434+ qui, elles, portent bien le TTL par défaut (donc atteignent
 * directement la cible). Le paquet encapsulé dans le Time Exceeded est donc
 * ICMP (echo-request), pas UDP comme le pseudocode du scénario le suppose —
 * on garde ce qui correspond à la réalité de la plateforme plutôt que de
 * forcer une hypothèse qui n'est pas ce que `traceroute` fait ici.
 * `nc -u` (jusqu'ici un stub qui refusait tout) envoie maintenant un vrai
 * datagramme UDP sur le fil (voir fix `Nc.ts`), ce qui rend le Port
 * Unreachable directement observable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ATTACKER_IP = '192.168.10.101';
const TARGET_IP = '192.168.20.10';
const R1_NEAR_IP = '192.168.10.1';
const R1_FAR_IP = '192.168.20.1';

interface Lab { attacker: LinuxPC; r1: CiscoRouter; target: LinuxServer }

function buildLab(): Lab {
  const attacker = new LinuxPC('linux-pc', 'ATTACKER', 0, 0);
  const r1 = new CiscoRouter('R1', 100, 0);
  const target = new LinuxServer('linux-server', 'TARGET', 200, 0);
  new Cable('c1').connect(attacker.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r1.getPort('GigabitEthernet0/1')!, target.getPort('eth0')!);
  return { attacker, r1, target };
}

async function configureLab(lab: Lab): Promise<void> {
  await lab.attacker.executeCommand(`ifconfig eth0 ${ATTACKER_IP} netmask 255.255.255.0`);
  await lab.attacker.executeCommand(`ip route add default via ${R1_NEAR_IP}`);

  await lab.r1.executeCommand('enable');
  await lab.r1.executeCommand('configure terminal');
  await lab.r1.executeCommand('interface GigabitEthernet0/0');
  await lab.r1.executeCommand(`ip address ${R1_NEAR_IP} 255.255.255.0`);
  await lab.r1.executeCommand('no shutdown');
  await lab.r1.executeCommand('exit');
  await lab.r1.executeCommand('interface GigabitEthernet0/1');
  await lab.r1.executeCommand(`ip address ${R1_FAR_IP} 255.255.255.0`);
  await lab.r1.executeCommand('no shutdown');
  await lab.r1.executeCommand('end');

  await lab.target.executeCommand(`ifconfig eth0 ${TARGET_IP} netmask 255.255.255.0`);
  await lab.target.executeCommand(`ip route add default via ${R1_FAR_IP}`);
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

/** `-tt` epoch-timestamp lines only — excludes tcpdump's own stderr banner. */
function dataLines(output: string): string[] {
  return output.split('\n').filter((l) => !/^tcpdump:|packets? captured|packets received by filter|packets dropped by kernel|^listening on/.test(l.trim()));
}

describe('Scénario 9 — Analyse des messages ICMP avancés avec tcpdump natif', () => {
  describe('Traceroute et ICMP Time Exceeded', () => {
    it('capture le Time Exceeded à chaque saut avec le paquet IP original encapsulé', async () => {
      const lab = buildLab();
      await configureLab(lab);

      const pending = lab.attacker.executeCommand(
        `tcpdump -i eth0 -nn -vvv 'icmp or (udp and portrange 33434-33534)' -w /tmp/traceroute.pcap`,
      );
      await new Promise((r) => setTimeout(r, 20));
      await lab.attacker.executeCommand(`traceroute -n ${TARGET_IP}`);
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const analysis = await lab.attacker.executeCommand(
        `tcpdump -nn -vvv -r /tmp/traceroute.pcap | grep -A 3 'time exceeded'`,
      );
      expect(analysis).toMatch(/time exceeded in-transit/);
      // Type 11 code 0 is exactly what real tcpdump renders as "time exceeded
      // in-transit" — the platform doesn't print the numeric type/code
      // alongside the phrase (neither does real tcpdump without -e), so the
      // phrase itself is the faithful equivalent of the scenario's
      // "icmp type-11 code-0 (time exceeded in-transit)".
      expect(analysis).toMatch(new RegExp(`${R1_NEAR_IP} > ${ATTACKER_IP}: ICMP time exceeded in-transit`));
      // Encapsulated original datagram — real tcpdump nests it as a second
      // "IP (...)\n    src > dst: ..." block right under the ICMP line,
      // carrying the offending echo request's own src/dst/ttl/proto.
      expect(analysis).toMatch(/\tIP \(tos 0x0, ttl 1, id \d+, offset 0, flags \[[^\]]+\], proto ICMP \(1\), length \d+\)/);
      expect(analysis).toMatch(new RegExp(`${ATTACKER_IP} > ${TARGET_IP}: ICMP`));
    });

    it('reconstitue la séquence traceroute depuis la capture : TTL croissant → Time Exceeded par saut → réponse finale', async () => {
      const lab = buildLab();
      await configureLab(lab);

      const pending = lab.attacker.executeCommand(
        `tcpdump -i eth0 -nn -vvv 'icmp or (udp and portrange 33434-33534)' -w /tmp/traceroute2.pcap`,
      );
      await new Promise((r) => setTimeout(r, 20));
      await lab.attacker.executeCommand(`traceroute -n ${TARGET_IP}`);
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const full = await lab.attacker.executeCommand(`tcpdump -nn -vvv -r /tmp/traceroute2.pcap`);
      const lines = dataLines(full);

      // TTL croissant sur les échos sortants de l'attaquant — le TTL est sur
      // la ligne d'en-tête "IP (...)", le src/dst/type sur la ligne suivante.
      const outboundTtls: number[] = [];
      for (let i = 0; i < lines.length - 1; i++) {
        const ttlMatch = /IP \(tos 0x0, ttl (\d+),.*proto ICMP/.exec(lines[i]);
        if (!ttlMatch) continue;
        const next = lines[i + 1];
        if (next.includes(`${ATTACKER_IP} > `) && next.includes('echo request')) {
          outboundTtls.push(Number(ttlMatch[1]));
        }
      }
      expect(outboundTtls.length).toBeGreaterThan(0);
      expect(outboundTtls[0]).toBe(1);
      expect(Math.max(...outboundTtls)).toBeGreaterThan(outboundTtls[0]);

      // R1, l'unique routeur intermédiaire, apparaît comme source d'un Time
      // Exceeded — c'est ce hop qui est "identifié" par la capture.
      expect(full).toMatch(new RegExp(`${R1_NEAR_IP} > ${ATTACKER_IP}: ICMP time exceeded in-transit`));

      // Réponse finale : soit un echo reply de la cible (dernier saut ICMP
      // atteint), soit un Port Unreachable pour les sondes UDP 33434+ que
      // rien n'écoute sur TARGET — les deux signent l'arrivée à destination.
      const reachedDestination = /ICMP echo reply/.test(full)
        || new RegExp(`${TARGET_IP} > ${ATTACKER_IP}: ICMP .*udp port .* unreachable`).test(full);
      expect(reachedDestination).toBe(true);
    });
  });

  describe('ICMP Fragmentation Needed (PMTUD)', () => {
    it('un ping DF-set trop grand pour le MTU réduit du routeur déclenche un Fragmentation Needed avec Next-Hop MTU', async () => {
      const lab = buildLab();
      await configureLab(lab);

      await lab.r1.executeCommand('enable');
      await lab.r1.executeCommand('configure terminal');
      await lab.r1.executeCommand('interface GigabitEthernet0/1');
      await lab.r1.executeCommand('ip mtu 576');
      await lab.r1.executeCommand('end');

      const pending = lab.attacker.executeCommand(
        `tcpdump -i eth0 -nn -vvv 'icmp[icmptype] == 3 and icmp[icmpcode] == 4' -w /tmp/pmtud.pcap`,
      );
      await new Promise((r) => setTimeout(r, 20));
      await lab.attacker.executeCommand(`ping -M do -s 1000 -c 3 ${TARGET_IP}`);
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const analysis = await lab.attacker.executeCommand(`tcpdump -nn -vvv -r /tmp/pmtud.pcap`);
      expect(analysis).not.toMatch(/tcpdump: error/);
      const lines = dataLines(analysis).filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);
      expect(analysis).toMatch(new RegExp(`${R1_NEAR_IP} > ${ATTACKER_IP}: ICMP ${TARGET_IP} unreachable - need to frag \\(mtu 576\\)`));

      const grep = await lab.attacker.executeCommand(
        `tcpdump -nn -vvv -r /tmp/pmtud.pcap | awk '/unreachable/ || /frag/ || /mtu/ {print}'`,
      );
      expect(grep).toMatch(/need to frag \(mtu 576\)/);
    });
  });

  describe('ICMP Destination Unreachable — Port Unreachable', () => {
    it('un datagramme UDP vers un port fermé déclenche un Port Unreachable, différencié des autres codes', async () => {
      const lab = buildLab();
      await configureLab(lab);

      const pending = lab.attacker.executeCommand(
        `tcpdump -i eth0 -nn -vvv 'icmp[icmptype] == 3' -w /tmp/unreach.pcap`,
      );
      await new Promise((r) => setTimeout(r, 20));
      await lab.attacker.executeCommand(`echo "test" | nc -u ${TARGET_IP} 19999`);
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const analysis = await lab.attacker.executeCommand(
        `tcpdump -nn -vvv -r /tmp/unreach.pcap | awk '
          /unreachable/ {
            if (/port/) print "Code 3: Port Unreachable"
            else if (/host/) print "Code 1: Host Unreachable"
            else if (/net/) print "Code 0: Net Unreachable"
            else if (/frag/) print "Code 4: Fragmentation Needed"
            print $0
          }'`,
      );
      expect(analysis).toMatch(/Code 3: Port Unreachable/);
      expect(analysis).toMatch(new RegExp(`${TARGET_IP} udp port 19999 unreachable`));
    });

    it("expose le paquet IP original encapsulé (IP source/destination et port UDP déclencheur)", async () => {
      const lab = buildLab();
      await configureLab(lab);

      const pending = lab.attacker.executeCommand(
        `tcpdump -i eth0 -nn -vvv 'icmp[icmptype] == 3' -w /tmp/unreach2.pcap`,
      );
      await new Promise((r) => setTimeout(r, 20));
      await lab.attacker.executeCommand(`echo "test" | nc -u ${TARGET_IP} 19999`);
      await new Promise((r) => setTimeout(r, 30));
      await pending;

      const analysis = await lab.attacker.executeCommand(
        `tcpdump -nn -vvv -r /tmp/unreach2.pcap | grep -A 10 'unreachable'`,
      );
      // Le paquet déclencheur encapsulé : IP source (attaquant) / IP
      // destination (cible) et port UDP 19999.
      expect(analysis).toMatch(/\tIP \(tos 0x0, ttl \d+, id \d+, offset 0, flags \[[^\]]+\], proto UDP \(17\), length \d+\)/);
      expect(analysis).toMatch(new RegExp(`${ATTACKER_IP}\\.\\d+ > ${TARGET_IP}\\.19999: UDP`));
    });
  });

  describe('critère de réussite', () => {
    it('type/code ICMP, paquet original encapsulé et Next-Hop MTU sont tous natifs à tcpdump, sans outil externe', async () => {
      const lab = buildLab();
      await configureLab(lab);

      await lab.r1.executeCommand('enable');
      await lab.r1.executeCommand('configure terminal');
      await lab.r1.executeCommand('interface GigabitEthernet0/1');
      await lab.r1.executeCommand('ip mtu 576');
      await lab.r1.executeCommand('end');

      const pending = lab.attacker.executeCommand(
        `tcpdump -i eth0 -nn -vvv 'icmp or (udp and portrange 33434-33534)' -w /tmp/full-incident.pcap`,
      );
      await new Promise((r) => setTimeout(r, 20));
      await lab.attacker.executeCommand(`traceroute -n ${TARGET_IP}`);
      await lab.attacker.executeCommand(`ping -M do -s 1000 -c 2 ${TARGET_IP}`);
      await lab.attacker.executeCommand(`echo "test" | nc -u ${TARGET_IP} 19999`);
      await new Promise((r) => setTimeout(r, 40));
      await pending;

      const full = await lab.attacker.executeCommand(`tcpdump -nn -vvv -r /tmp/full-incident.pcap`);

      // Type et code ICMP natifs (aucun outil externe) :
      expect(full).toMatch(/ICMP time exceeded in-transit/);
      expect(full).toMatch(/need to frag \(mtu 576\)/);
      expect(full).toMatch(/udp port \d+ unreachable/);

      // Paquet IP original encapsulé, natif à la sortie -vvv :
      const encapsulatedBlocks = dataLines(full).filter((l) => l.trim().startsWith('IP (') && l.includes('proto'));
      expect(encapsulatedBlocks.length).toBeGreaterThan(1); // au moins un outer + un encapsulé

      // Next-Hop MTU dans le message Fragmentation Needed :
      expect(full).toMatch(/mtu 576/);
    });
  });
});
