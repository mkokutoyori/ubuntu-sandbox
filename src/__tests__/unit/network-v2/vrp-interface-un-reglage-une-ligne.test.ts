import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function port(lignes: readonly string[]) {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1');
  await sw.executeCommand('system-view');
  await sw.executeCommand('interface GigabitEthernet0/0/1');
  for (const l of lignes) await sw.executeCommand(l);
  return { sw, vue: await sw.executeCommand('display this') };
}

function comptees(vue: string, prefixe: string): string[] {
  return vue.split('\n').map(l => l.trim()).filter(l => l.startsWith(prefixe));
}

describe('VRP : une commande tapee deux fois ne fait pas deux lignes', () => {
  it('la meme ligne exactement n est gardee qu une fois', async () => {
    const { vue } = await port(['mac-limit maximum 5', 'mac-limit maximum 5']);

    expect(comptees(vue, 'mac-limit')).toEqual(['mac-limit maximum 5']);
  });

  it('un drapeau repete n est pose qu une fois', async () => {
    const { vue } = await port(['qinq enable', 'qinq enable', 'qinq enable']);

    expect(comptees(vue, 'qinq')).toEqual(['qinq enable']);
  });

  it('`dhcp snooping trusted` repete de meme', async () => {
    const { vue } = await port(['dhcp snooping trusted', 'dhcp snooping trusted']);

    expect(comptees(vue, 'dhcp snooping trusted').length).toBe(1);
  });
});

describe('VRP : une valeur en remplace une autre pour le meme reglage', () => {
  it('deux seuils de suppression de diffusion ne coexistent pas', async () => {
    const { vue } = await port(['broadcast-suppression 30', 'broadcast-suppression 40']);

    expect(comptees(vue, 'broadcast-suppression')).toEqual(['broadcast-suppression 40']);
  });

  it('deux tailles de trame jumbo non plus', async () => {
    const { vue } = await port(['jumboframe enable 9216', 'jumboframe enable 1600']);

    expect(comptees(vue, 'jumboframe')).toEqual(['jumboframe enable 1600']);
  });

  it('deux limites MAC de PORT non plus', async () => {
    const { vue } = await port(['mac-limit maximum 5', 'mac-limit maximum 10']);

    expect(comptees(vue, 'mac-limit')).toEqual(['mac-limit maximum 10']);
  });

  it('une limite par VLAN ne remplace pas celle du port : les portees different', async () => {
    const { vue } = await port(['mac-limit maximum 5', 'mac-limit maximum 5 vlan 10']);

    expect(comptees(vue, 'mac-limit')).toEqual([
      'mac-limit maximum 5', 'mac-limit maximum 5 vlan 10',
    ]);
  });
});

describe('VRP : ce qui doit s ACCUMULER s accumule toujours', () => {
  it('deux VLAN autorises sur le trunk tiennent dans une ligne', async () => {
    const { vue } = await port([
      'port link-type trunk',
      'port trunk allow-pass vlan 10',
      'port trunk allow-pass vlan 20',
    ]);

    const lignes = comptees(vue, 'port trunk allow-pass');
    expect(lignes.length).toBe(1);
    expect(lignes[0]).toContain('10');
    expect(lignes[0]).toContain('20');
  });

  it('deux correspondances de VLAN differentes coexistent', async () => {
    const { vue } = await port([
      'port vlan-mapping vlan 10 map-vlan 100',
      'port vlan-mapping vlan 20 map-vlan 200',
    ]);

    expect(comptees(vue, 'port vlan-mapping').length).toBe(2);
  });

  it('deux protocoles tunnelises coexistent', async () => {
    const { vue } = await port(['bpdu-tunnel stp enable', 'bpdu-tunnel lldp enable']);

    expect(comptees(vue, 'bpdu-tunnel').length).toBe(2);
  });

  it('un reglage pose reste lisible apres un autre reglage', async () => {
    const { vue } = await port([
      'broadcast-suppression 30',
      'qinq enable',
      'mac-limit maximum 7',
    ]);

    expect(comptees(vue, 'broadcast-suppression')).toEqual(['broadcast-suppression 30']);
    expect(comptees(vue, 'qinq')).toEqual(['qinq enable']);
    expect(comptees(vue, 'mac-limit')).toEqual(['mac-limit maximum 7']);
  });
});
