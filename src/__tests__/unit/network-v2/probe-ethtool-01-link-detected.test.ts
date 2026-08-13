/**
 * Probes — `ethtool`, la commande que la porteuse a rendue possible.
 *
 * `docs/PRD-Link-State.md` §5 la déclarait hors périmètre, et la raison
 * était juste : sa ligne la plus lue, `Link detected:`, n'est rien
 * d'autre que la porteuse, et la porteuse n'existait pas. Depuis le §6
 * elle existe — et elle tient compte de l'émetteur d'en face —, si bien
 * que la commande n'a plus rien à inventer.
 *
 * Ces probes vérifient donc surtout une chose : que la sortie **suit**
 * l'état réel du lien, y compris quand la panne est chez le voisin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

interface Lab { sw: CiscoSwitch; pc: LinuxPC; peer: LinuxPC; cable: Cable }

async function lab(): Promise<Lab> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const peer = new LinuxPC('linux-pc', 'peer', 0, 0);
  pc.powerOn(); peer.powerOn();
  const cable = new Cable('c1');
  cable.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
  new Cable('c2').connect(sw.getPort('FastEthernet0/2')!, peer.getPort('eth0')!);
  await pc.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await peer.executeCommand('sudo ip addr add 192.168.1.20/24 dev eth0');
  await sw.executeCommand('enable');
  return { sw, pc, peer, cable };
}

const linkLine = (out: string) => out.split('\n').find(l => l.includes('Link detected'))?.trim() ?? '';

describe('Scénario 1 — `Link detected` dit la vérité, quelle que soit la cause', () => {
  it('lien sain : `yes`, avec vitesse et duplex négociés', async () => {
    const l = await lab();
    const out = await l.pc.executeCommand('ethtool eth0');
    expect(linkLine(out)).toBe('Link detected: yes');
    expect(out).toMatch(/Speed: \d+Mb\/s/);
    expect(out).toMatch(/Duplex: (Full|Half)/);
  });

  it('câble arraché : `no`, et la vitesse redevient inconnue', async () => {
    const l = await lab();
    l.cable.disconnect();
    const out = await l.pc.executeCommand('ethtool eth0');
    expect(linkLine(out)).toBe('Link detected: no');
    // Le vrai ethtool n'invente pas une vitesse sur un lien mort.
    expect(out).toContain('Speed: Unknown!');
    expect(out).toContain('Duplex: Unknown! (255)');
  });

  it('port du commutateur désactivé : le poste le voit aussi', async () => {
    const l = await lab();
    for (const c of ['configure terminal', 'interface FastEthernet0/1', 'shutdown', 'end']) {
      await l.sw.executeCommand(c);
    }
    // C'est précisément ce que la porteuse « d'en face » a rendu
    // possible : rien n'a bougé côté poste.
    expect(linkLine(await l.pc.executeCommand('ethtool eth0'))).toBe('Link detected: no');
  });

  it('commutateur hors tension : même verdict', async () => {
    const l = await lab();
    l.sw.powerOff();
    expect(linkLine(await l.pc.executeCommand('ethtool eth0'))).toBe('Link detected: no');
  });

  it('la reprise se voit tout autant', async () => {
    const l = await lab();
    l.sw.powerOff();
    expect(linkLine(await l.pc.executeCommand('ethtool eth0'))).toBe('Link detected: no');
    l.sw.powerOn();
    expect(linkLine(await l.pc.executeCommand('ethtool eth0'))).toBe('Link detected: yes');
  });
});

describe('Scénario 2 — `-i` et `-S` lisent le port, pas un gabarit', () => {
  it('`-i` nomme l\'interface interrogée et son MTU réel', async () => {
    const l = await lab();
    await l.pc.executeCommand('sudo ip link set eth0 mtu 9000');
    const out = await l.pc.executeCommand('ethtool -i eth0');
    expect(out).toContain('interface: eth0');
    expect(out).toContain('mtu: 9000');
    expect(out).toContain('driver: e1000');
  });

  it('`-S` compte le trafic qui est réellement passé', async () => {
    const l = await lab();
    const before = await l.pc.executeCommand('ethtool -S eth0');
    const txBefore = Number(/tx_packets: (\d+)/.exec(before)?.[1] ?? -1);

    await pingOnSimulatedClock(l.pc, 'ping -c 2 192.168.1.20');

    const after = await l.pc.executeCommand('ethtool -S eth0');
    const txAfter = Number(/tx_packets: (\d+)/.exec(after)?.[1] ?? -1);
    expect(txAfter).toBeGreaterThan(txBefore);
  }, 30_000);

  it('`-S` distingue les erreurs des rejets', async () => {
    const l = await lab();
    const out = await l.pc.executeCommand('ethtool -S eth0');
    for (const k of ['rx_packets', 'tx_packets', 'rx_bytes', 'tx_bytes',
      'rx_errors', 'tx_errors', 'rx_dropped', 'tx_dropped', 'rx_crc_errors']) {
      expect(out).toContain(`${k}: `);
    }
  });
});

describe('Scénario 3 — les refus', () => {
  it('une interface inexistante rend l\'erreur du noyau', async () => {
    const l = await lab();
    const out = await l.pc.executeCommand('ethtool eth9');
    expect(out).toContain('No such device');
  });

  it('sans argument, la commande renvoie à son aide', async () => {
    const l = await lab();
    expect(await l.pc.executeCommand('ethtool')).toContain('bad command line argument');
  });

  it('les formes d\'écriture sont refusées, pas avalées', async () => {
    const l = await lab();
    // Répondre OK à `-s speed 100` sans rien changer serait pire que
    // refuser : l'opérateur croirait avoir forcé la vitesse.
    const out = await l.pc.executeCommand('ethtool -s eth0 speed 100');
    expect(out).toContain('not supported');
    expect(out).toContain('read-only');
  });
});
