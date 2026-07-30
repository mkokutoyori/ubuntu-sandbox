/**
 * Probes — la porteuse vient d'en face.
 *
 * Un port a de la porteuse quand quelque chose, à l'autre bout du
 * câble, émet. Le simulateur ne regardait que son propre côté :
 * `cable !== null && cable.getIsUp()`. Un `shutdown` sur le port du
 * switch, ou le switch mis hors tension, laissaient donc le poste
 * raccordé en `LOWER_UP` avec `carrier=1`, alors que ces deux gestes
 * éteignent réellement l'émetteur du port.
 *
 * Ces probes tiennent les trois causes de perte de porteuse et
 * vérifient qu'elles produisent le même symptôme côté voisin — c'est
 * précisément ce qui rend un câble débranché indistinguable d'un port
 * désactivé DEPUIS LE POSTE, et ce que le scénario de panne enseigne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

interface Lab { sw: CiscoSwitch; pc: LinuxPC; cable: Cable }

async function lab(): Promise<Lab> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  const cable = new Cable('c1');
  cable.connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
  await pc.executeCommand('sudo ip addr add 192.168.10.101/24 dev eth0');
  await sw.executeCommand('enable');
  return { sw, pc, cable };
}

async function shutdown(sw: CiscoSwitch, iface: string): Promise<void> {
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${iface}`);
  await sw.executeCommand('shutdown');
  await sw.executeCommand('end');
}

async function noShutdown(sw: CiscoSwitch, iface: string): Promise<void> {
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${iface}`);
  await sw.executeCommand('no shutdown');
  await sw.executeCommand('end');
}

/** Ce que le poste dit de son lien. */
const vuDuPoste = async (pc: LinuxPC) => ({
  carrier: (await pc.executeCommand('cat /sys/class/net/eth0/carrier')).trim(),
  link: await pc.executeCommand('ip link show eth0'),
});

describe('Scénario 1 — trois causes, un seul symptôme côté voisin', () => {
  for (const [nom, casser] of [
    ['le câble est débranché', async (l: Lab) => l.cable.disconnect()],
    ['le port du switch est désactivé', async (l: Lab) => shutdown(l.sw, 'FastEthernet0/1')],
    ['le switch est mis hors tension', async (l: Lab) => { l.sw.powerOff(); }],
  ] as const) {
    it(nom, async () => {
      const l = await lab();
      const avant = await vuDuPoste(l.pc);
      expect(avant.carrier).toBe('1');
      expect(avant.link).toContain('LOWER_UP');

      await casser(l);

      const apres = await vuDuPoste(l.pc);
      expect(apres.carrier, 'le poste ne peut pas distinguer ces trois causes').toBe('0');
      expect(apres.link).toContain('NO-CARRIER');
      expect(apres.link).toContain('state DOWN');
    });
  }

  it('la porteuse revient quand l\'émetteur d\'en face se rallume', async () => {
    const l = await lab();
    await shutdown(l.sw, 'FastEthernet0/1');
    expect((await vuDuPoste(l.pc)).carrier).toBe('0');

    await noShutdown(l.sw, 'FastEthernet0/1');
    const repris = await vuDuPoste(l.pc);
    expect(repris.carrier).toBe('1');
    expect(repris.link).toContain('LOWER_UP');
  });

  it('la remise sous tension du switch rétablit la porteuse du voisin', async () => {
    const l = await lab();
    l.sw.powerOff();
    expect((await vuDuPoste(l.pc)).carrier).toBe('0');
    l.sw.powerOn();
    expect((await vuDuPoste(l.pc)).carrier).toBe('1');
  });

  it('un port sans voisin du tout n\'a pas de porteuse', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    expect(sw.getPort('FastEthernet0/5')!.hasCarrier()).toBe(false);
  });
});

describe('Scénario 2 — ce que le switch en dit, et ce que la route en fait', () => {
  it('le motif de la panne suit l\'état du port dans `show interfaces`', async () => {
    const l = await lab();
    expect(await l.sw.executeCommand('show interfaces FastEthernet0/1'))
      .toContain('FastEthernet0/1 is up, line protocol is up');

    l.cable.disconnect();
    // Un Catalyst nomme la cause entre parenthèses ; un routeur, non.
    expect(await l.sw.executeCommand('show interfaces FastEthernet0/1'))
      .toContain('line protocol is down (notconnect)');

    await shutdown(l.sw, 'FastEthernet0/2');
    expect(await l.sw.executeCommand('show interfaces FastEthernet0/2'))
      .toContain('line protocol is down (disabled)');
  });

  it('l\'extinction du voisin fait passer l\'uplink en `notconnect`', async () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    new Cable('uplink').connect(sw1.getPort('FastEthernet0/8')!, sw2.getPort('FastEthernet0/8')!);
    await sw1.executeCommand('enable');
    expect(await sw1.executeCommand('show interfaces status')).toMatch(/Fa0\/8\s+connected/);

    sw2.powerOff();
    expect(await sw1.executeCommand('show interfaces status')).toMatch(/Fa0\/8\s+notconnect/);
  });

  it('la perte de porteuse marque la route, la descente administrative la retire', async () => {
    const l = await lab();
    expect(await l.pc.executeCommand('ip route show')).not.toContain('linkdown');

    l.cable.disconnect();
    // Linux garde la route et la signale ; il ne la retire que lorsque
    // l'interface elle-même descend.
    expect(await l.pc.executeCommand('ip route show')).toMatch(/192\.168\.10\.0\/24.*linkdown/);

    await l.pc.executeCommand('sudo ip link set eth0 down');
    expect(await l.pc.executeCommand('ip route show')).not.toContain('192.168.10.0/24');
  });

  it('les deux journaux d\'une perte de lien : le pilote et networkd', async () => {
    const l = await lab();
    l.cable.disconnect();
    const syslog = await l.pc.executeCommand('cat /var/log/syslog');
    expect(syslog).toMatch(/eth0: Link is Down/);
    expect(syslog).toContain('Lost carrier');
  });
});
