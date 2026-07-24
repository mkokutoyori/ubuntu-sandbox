/**
 * Scénario 6 (Cisco) — NAT Hairpinning : accès à un serveur interne via
 * son IP publique depuis l'intérieur.
 *
 * Transcription littérale et fidèle : sans configuration spécifique, un
 * hôte du LAN qui cible l'IP publique statique d'un serveur interne
 * (203.0.113.10 → Oracle) voit la destination re-traduite en interne
 * (`translateInbound`, branche « hairpin » — le moteur applique cette
 * traduction pour tout paquet, y compris ceux arrivant sur une
 * interface inside), mais la source n'est PAS re-traduite puisque la
 * décision de routage renvoie le paquet par l'interface inside
 * elle-même (`translateOutbound` exige explicitement une interface
 * outside) — Oracle répond donc avec son IP privée réelle plutôt que
 * l'IP publique attendue par le client, cassant la session. La
 * correction proposée (ACL-HAIRPIN + PAT overload) est vérifiée
 * littéralement contre le comportement réel du moteur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters, createIPv4Packet, IP_PROTO_TCP } from '@/network/core/types';
import type { TCPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const PC_LINUX1_IP = '192.168.10.101';
const SRV_ORACLE_IP = '192.168.10.20';
const ORACLE_PUBLIC_IP = '203.0.113.10';

interface Lab {
  pcLinux1: LinuxPC;
  srvOracle: LinuxServer;
  router: CiscoRouter;
}

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const pcLinux1 = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
  const srvOracle = new LinuxServer('linux-server', 'srv-oracle', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(pcLinux1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(srvOracle.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  pcLinux1.getPorts()[0].configureIP(new IPAddress(PC_LINUX1_IP), m);
  srvOracle.getPorts()[0].configureIP(new IPAddress(SRV_ORACLE_IP), m);
  pcLinux1.setDefaultGateway(new IPAddress(GW_INSIDE));
  srvOracle.setDefaultGateway(new IPAddress(GW_INSIDE));
  outside.getPorts()[0].configureIP(new IPAddress('203.0.113.2'), new SubnetMask('255.255.255.252'));
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  for (const cmd of [
    'enable',
    'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside',
    'no shutdown',
    'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'ip nat outside',
    'no shutdown',
    'exit',
    `ip nat inside source static tcp ${SRV_ORACLE_IP} 1521 ${ORACLE_PUBLIC_IP} 1521`,
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { pcLinux1, srvOracle, router };
}

function makeOracleSyn(): ReturnType<typeof createIPv4Packet> {
  const tcp: TCPPacket = {
    type: 'tcp', sourcePort: 50001, destinationPort: 1521,
    sequenceNumber: 1, acknowledgmentNumber: 0, dataOffset: 5,
    flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
    window: 65535, checksum: 0, urgentPointer: 0, options: [], payload: null,
  };
  return createIPv4Packet(new IPAddress(PC_LINUX1_IP), new IPAddress(ORACLE_PUBLIC_IP), IP_PROTO_TCP, 64, tcp, 40);
}

describe('Scénario 6 (Cisco) — NAT Hairpinning : accès interne via l\'IP publique', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('démonstration du problème sans hairpinning', () => {
    it('translateInbound réécrit bien la destination (203.0.113.10 → 192.168.10.20) même pour un paquet arrivant sur l\'interface inside', async () => {
      const { router } = await buildLab();
      const engine = router._getNATEngine();
      const pkt = makeOracleSyn();
      const afterDnat = engine.translateInbound(pkt, 'GigabitEthernet0/0');
      expect(afterDnat).not.toBeNull();
      expect(afterDnat!.destinationIP.toString()).toBe(SRV_ORACLE_IP);
    });

    it('sans règle PAT dédiée au hairpin, la source n\'est PAS traduite lorsque le paquet ressort par l\'interface inside (translateOutbound refuse une interface non-outside)', async () => {
      const { router } = await buildLab();
      const engine = router._getNATEngine();
      const pkt = makeOracleSyn();
      const afterDnat = engine.translateInbound(pkt, 'GigabitEthernet0/0')!;
      // La décision de routage envoie ce paquet vers Oracle par l'interface
      // inside elle-même (192.168.10.20 y est directement connecté).
      const afterSnat = engine.translateOutbound(afterDnat, 'GigabitEthernet0/0', 'GigabitEthernet0/0');
      expect(afterSnat).toBeNull();
    });

    it('une connexion nc directe vers 203.0.113.10:1521 depuis PC-Linux-1 échoue sans configuration de hairpinning', async () => {
      const { pcLinux1 } = await buildLab();
      const out = await pcLinux1.executeCommand(`nc -z -w 1 ${ORACLE_PUBLIC_IP} 1521`);
      // 203.0.113.10 n'est l'IP d'aucune interface réelle (seulement une
      // cible de traduction NAT statique) : nc échoue dès la résolution
      // d'hôte, avant même d'atteindre la logique de traduction.
      expect(out).toMatch(/getaddrinfo/i);
    });
  });

  describe('configuration du NAT Hairpinning (ACL-HAIRPIN + PAT overload)', () => {
    async function labWithHairpinFix(): Promise<Lab> {
      const lab = await buildLab();
      for (const cmd of [
        'enable', 'configure terminal',
        'ip access-list extended ACL-HAIRPIN',
        `10 permit ip 192.168.10.0 0.0.0.255 host ${ORACLE_PUBLIC_IP}`,
        'exit',
        'ip nat inside source list ACL-HAIRPIN interface GigabitEthernet0/1 overload',
        'end',
      ]) await lab.router.executeCommand(cmd);
      return lab;
    }

    it('après configuration, nc -z 203.0.113.10:1521 depuis PC-Linux-1 réussit', async () => {
      const { pcLinux1 } = await labWithHairpinFix();
      const out = await pcLinux1.executeCommand(`nc -z -w 1 ${ORACLE_PUBLIC_IP} 1521`);
      expect(out).toMatch(/succeeded/i);
    });

    it('show ip nat translations montre deux traductions simultanées pour la session hairpin (source PAT ET destination statique)', async () => {
      const { pcLinux1, router } = await labWithHairpinFix();
      await pcLinux1.executeCommand(`nc -z -w 1 ${ORACLE_PUBLIC_IP} 1521`);

      const out = await router.executeCommand('show ip nat translations');
      expect(out).toMatch(new RegExp(`${GW_OUTSIDE.replace(/\./g, '\\.')}:\\d+\\s+${PC_LINUX1_IP.replace(/\./g, '\\.')}:\\d+\\s+${ORACLE_PUBLIC_IP.replace(/\./g, '\\.')}:1521\\s+${SRV_ORACLE_IP.replace(/\./g, '\\.')}:1521`));
    });
  });
});
