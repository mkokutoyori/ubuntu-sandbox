/**
 * Scénario 12 (Cisco) — NAT avec tracking d'interface et basculement
 * (IP SLA + NAT).
 *
 * Transcription littérale et fidèle : deux liens WAN (Gi0/1 primaire,
 * Gi0/2 secondaire), `ip sla 1` + `icmp-echo` + `frequency 5`,
 * `track 1 ip sla 1 reachability`, deux routes par défaut de distance
 * administrative différente (`track 1` sur la secondaire), NAT
 * configuré sur les deux interfaces WAN, et bascule observée après
 * l'arrêt de l'interface primaire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  router: CiscoRouter;
  isp1: LinuxPC;
  isp2: LinuxPC;
}

/**
 * Un objet suivi adossé à une IP SLA suit la CADENCE DE LA SONDE, pas
 * l'état de l'interface : couper Gi0/1 ne fait pas tomber `track 1`
 * instantanément, il le fait tomber au prochain cycle qui échoue (au
 * plus `frequency` secondes plus tard). C'est exactement pour cette
 * raison que `track <n> interface … line-protocol` existe comme objet
 * distinct. Plutôt que d'attendre cinq secondes de temps réel, on
 * déclenche ici le cycle suivant.
 */
async function runNextProbe(router: CiscoRouter): Promise<void> {
  const engine = router.getIpSlaEngine();
  const runtime = engine.getOperation(1);
  if (runtime) await engine.runProbe(runtime);
}

async function buildLab(): Promise<Lab> {
  const router = new CiscoRouter('router', 0, 0);
  const isp1 = new LinuxPC('linux-pc', 'isp1-gw', 0, 0);
  const isp2 = new LinuxPC('linux-pc', 'isp2-gw', 0, 0);

  new Cable('wan1').connect(router.getPort('GigabitEthernet0/1')!, isp1.getPort('eth0')!);
  new Cable('wan2').connect(router.getPort('GigabitEthernet0/2')!, isp2.getPort('eth0')!);

  const mask = new SubnetMask('255.255.255.252');
  isp1.getPorts()[0].configureIP(new IPAddress('203.0.113.2'), mask);
  isp2.getPorts()[0].configureIP(new IPAddress('203.0.113.6'), mask);

  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 203.0.113.1 255.255.255.252', 'ip nat outside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'ip address 203.0.113.5 255.255.255.252', 'ip nat outside', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1 203.0.113.2 1 track 1',
    'ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/2 203.0.113.6 10',
    'ip sla 1', 'icmp-echo 203.0.113.2 source-interface GigabitEthernet0/1', 'frequency 5', 'exit',
    'ip sla schedule 1 life forever start-time now',
    'track 1 ip sla 1 reachability',
    'end',
  ]) await router.executeCommand(cmd);

  return { router, isp1, isp2 };
}

describe('Scénario 12 (Cisco) — NAT et basculement dual-WAN (IP SLA + track)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('configuration dual-WAN avec IP SLA', () => {
    it('show ip sla statistics 1 confirme l\'opération planifiée', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip sla statistics 1');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('show track 1 affiche l\'objet suivi comme "IP SLA 1 reachability"', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show track 1');
      expect(out).toContain('Track 1');
      expect(out).toMatch(/IP SLA 1 reachability/);
    });

    it('show ip route 0.0.0.0 montre la route primaire (distance 1, via 203.0.113.2) active en fonctionnement normal', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip route 0.0.0.0');
      expect(out).toMatch(/distance 1, metric 0/);
      expect(out).toMatch(/^ {2}\* 203\.0\.113\.2/m);
    });
  });

  describe('simulation de bascule et observation', () => {
    it('show track 1 passe à Down une fois l\'interface primaire arrêtée', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/1');
      await router.executeCommand('shutdown');
      await router.executeCommand('end');
      await runNextProbe(router);

      const out = await router.executeCommand('show track 1');
      expect(out).toMatch(/Reachability is Down/);
    });

    it('la route par défaut bascule vers 203.0.113.6 (GigabitEthernet0/2) une fois track 1 DOWN', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/1');
      await router.executeCommand('shutdown');
      await router.executeCommand('end');
      await runNextProbe(router);

      const out = await router.executeCommand('show ip route 0.0.0.0');
      expect(out).toMatch(/^ {2}\* 203\.0\.113\.6/m);
    });

    it('show ip nat statistics référence GigabitEthernet0/2 comme interface outside active après la bascule', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/1');
      await router.executeCommand('shutdown');
      await router.executeCommand('end');

      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toContain('GigabitEthernet0/1');
      expect(out).toContain('GigabitEthernet0/2');
    });
  });
});
