/**
 * Probes — les trois issues d'un `ping` Windows qui échoue.
 *
 * Windows ne dit pas « ça n'a pas marché » d'une seule façon, et la
 * différence est un diagnostic à elle seule :
 *
 *   PING: transmit failed. General failure.   la pile refuse d'émettre
 *   Reply from <soi>: Destination host unreachable.   l'ARP local échoue
 *   Request timed out.                        parti, rien en retour
 *   Reply from <routeur>: Destination host unreachable.   ICMP reçu
 *
 * Le simulateur les confondait : `General failure` était choisi dès que
 * la séquence ne rendait aucun résultat, quelle qu'en soit la raison, et
 * le test d'émission ne regardait que l'état de ligne — jamais la
 * porteuse. Un câble arraché rendait donc « Destination host
 * unreachable », et une cible silencieuse sur le lien « General
 * failure » : les deux réponses, chacune à la place de l'autre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab { sw: CiscoSwitch; pc: WindowsPC; peer: LinuxPC; cable: Cable }

/** Un poste Windows et un voisin Linux sur le même commutateur. */
async function lab(): Promise<Lab> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  const peer = new LinuxPC('linux-pc', 'peer', 0, 0);
  pc.powerOn();
  peer.powerOn();
  const cable = new Cable('c1');
  cable.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
  new Cable('c2').connect(sw.getPort('FastEthernet0/2')!, peer.getPort('eth0')!);
  await pc.executeCmdCommand('netsh interface ip set address name="eth0" static 192.168.1.10 255.255.255.0');
  await peer.executeCommand('sudo ip addr add 192.168.1.20/24 dev eth0');
  return { sw, pc, peer, cable };
}

const TRANSMIT = 'PING: transmit failed. General failure.';
const TIMEOUT = 'Request timed out.';

/** Le résumé de Windows, dont le bloc des temps quand rien n'est revenu. */
function expectTotalLoss(out: string, target: string): void {
  expect(out).toContain(`Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),`);
  expect(out).toContain(`Ping statistics for ${target}:`);
  // Aucun aller-retour n'a eu lieu : il n'y a pas de temps à annoncer.
  expect(out).not.toContain('Approximate round trip times');
}

describe('Scénario 1 — la pile refuse d\'émettre', () => {
  it('le câble arraché : `General failure`, pas une absence de réponse', async () => {
    const l = await lab();
    l.cable.disconnect();
    const out = await l.pc.executeCmdCommand('ping 192.168.1.20');
    expect(out).toContain(TRANSMIT);
    expect(out).not.toContain(TIMEOUT);
    expectTotalLoss(out, '192.168.1.20');
  });

  it('le commutateur éteint : le poste ne peut pas plus émettre', async () => {
    const l = await lab();
    l.sw.powerOff();
    // Rien n'a bougé côté poste ; c'est l'émetteur d'en face qui s'est tu.
    expect(await l.pc.executeCmdCommand('ping 192.168.1.20')).toContain(TRANSMIT);
  });

  it('le port du commutateur désactivé produit le même refus', async () => {
    const l = await lab();
    for (const c of ['enable', 'configure terminal', 'interface FastEthernet0/1', 'shutdown', 'end']) {
      await l.sw.executeCommand(c);
    }
    expect(await l.pc.executeCmdCommand('ping 192.168.1.20')).toContain(TRANSMIT);
  });

  it('l\'interface locale descendue produit le même refus', async () => {
    const l = await lab();
    l.pc.getPort('eth0')!.setAdminDown(true);
    expect(await l.pc.executeCmdCommand('ping 192.168.1.20')).toContain(TRANSMIT);
  });

  it('une destination hors sous-réseau sans passerelle n\'a pas de route', async () => {
    const l = await lab();
    const out = await l.pc.executeCmdCommand('ping 100.100.11.1');
    expect(out).toContain(TRANSMIT);
    expectTotalLoss(out, '100.100.11.1');
  });
});

describe('Scénario 2 — le paquet part, et ce qui revient (ou pas)', () => {
  it('une cible vivante répond', async () => {
    const l = await lab();
    const out = await l.pc.executeCmdCommand('ping 192.168.1.20');
    expect(out).toContain('Reply from 192.168.1.20: bytes=32');
    expect(out).toContain('Received = 4');
    expect(out).toContain('Approximate round trip times');
  });

  it('une cible muette sur le lien : l\'ARP échoue, le poste se répond à lui-même', async () => {
    const l = await lab();
    const out = await l.pc.executeCmdCommand('ping 192.168.1.99');
    // C'est bien l'adresse du poste qui figure dans la réponse : la pile
    // locale renonce, aucun équipement distant n'a parlé.
    expect(out).toContain('Reply from 192.168.1.10: Destination host unreachable.');
    expect(out).not.toContain(TRANSMIT);
    expectTotalLoss(out, '192.168.1.99');
  });

  it('une destination routée et silencieuse expire', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const r1 = new CiscoRouter('R1', 0, 0);
    pc.powerOn();
    new Cable('a').connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
    new Cable('b').connect(sw.getPort('FastEthernet0/2')!, r1.getPort('GigabitEthernet0/0')!);
    await pc.executeCmdCommand(
      'netsh interface ip set address name="eth0" static 192.168.1.10 255.255.255.0 192.168.1.1');
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
      'ip route 100.100.11.0 255.255.255.0 Null0', 'end']) {
      await r1.executeCommand(c);
    }

    // La route existe, le lien porte, la trame sort : plus rien de local
    // n'explique l'échec, et Windows se contente d'attendre.
    const out = await pc.executeCmdCommand('ping 100.100.11.1');
    expect(out).toContain(TIMEOUT);
    expect(out).not.toContain(TRANSMIT);
    expectTotalLoss(out, '100.100.11.1');
  }, 60_000);
});

describe('Scénario 3 — la reprise redit la vérité', () => {
  it('le câble rebranché fait repartir les réponses', async () => {
    const l = await lab();
    l.cable.disconnect();
    expect(await l.pc.executeCmdCommand('ping 192.168.1.20')).toContain(TRANSMIT);

    new Cable('c1-bis').connect(l.sw.getPort('FastEthernet0/1')!, l.pc.getPort('eth0')!);
    expect(await l.pc.executeCmdCommand('ping 192.168.1.20'))
      .toContain('Reply from 192.168.1.20: bytes=32');
  });

  it('le commutateur rallumé aussi', async () => {
    const l = await lab();
    l.sw.powerOff();
    expect(await l.pc.executeCmdCommand('ping 192.168.1.20')).toContain(TRANSMIT);

    l.sw.powerOn();
    expect(await l.pc.executeCmdCommand('ping 192.168.1.20'))
      .toContain('Reply from 192.168.1.20: bytes=32');
  });
});
