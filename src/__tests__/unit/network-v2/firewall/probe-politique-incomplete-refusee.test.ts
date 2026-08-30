import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Fw {
  executeCommand(command: string): Promise<string>;
  getIsPoweredOn(): boolean;
  powerOn(): void;
}

function fortigate(): Fw {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Fw;
  if (!fw.getIsPoweredOn()) fw.powerOn();
  return fw;
}

async function taper(fw: Fw, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await fw.executeCommand(ligne));
  return sorties;
}

const COMPLETE_V4 = [
  'set srcintf "port1"', 'set dstintf "wan1"',
  'set srcaddr "all"', 'set dstaddr "all"',
  'set schedule "always"', 'set service "ALL"',
];

const REFUS = /Command fail/;

describe('une politique COMPLETE est acceptee — le temoin', () => {
  it('les six attributs poses, `next` passe', async () => {
    const fw = fortigate();
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 1', ...COMPLETE_V4, 'next',
    ]);

    expect(sorties[sorties.length - 1]).not.toMatch(REFUS);
  });

  it('et la politique parait dans la configuration', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1', ...COMPLETE_V4, 'next', 'end',
    ]);

    expect(await fw.executeCommand('show firewall policy')).toMatch(/edit 1/);
  });
});

describe('une politique INCOMPLETE est refusee au `next`', () => {
  const OBLIGATOIRES = ['srcintf', 'dstintf', 'srcaddr', 'dstaddr', 'service'];

  for (const manquant of OBLIGATOIRES) {
    it(`sans \`${manquant}\``, async () => {
      const fw = fortigate();
      const lignes = COMPLETE_V4.filter(l => !l.startsWith(`set ${manquant} `));
      const sorties = await taper(fw, [
        'config firewall policy', 'edit 1', ...lignes, 'next',
      ]);

      expect(sorties[sorties.length - 1]).toMatch(REFUS);
    });

    it(`et le refus NOMME \`${manquant}\``, async () => {
      const fw = fortigate();
      const lignes = COMPLETE_V4.filter(l => !l.startsWith(`set ${manquant} `));
      const sorties = await taper(fw, [
        'config firewall policy', 'edit 1', ...lignes, 'next',
      ]);

      expect(sorties[sorties.length - 1]).toContain(manquant);
    });
  }

  it('une politique vide est refusee', async () => {
    const fw = fortigate();
    const sorties = await taper(fw, ['config firewall policy', 'edit 1', 'next']);

    expect(sorties[sorties.length - 1]).toMatch(REFUS);
  });

  it('l entree refusee reste EN ATTENTE, et `abort` la jette', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 42', 'set srcintf "port1"', 'next',
    ]);
    expect(await fw.executeCommand('show firewall policy')).toMatch(/edit 42/);
    await fw.executeCommand('abort');

    expect(await fw.executeCommand('show firewall policy')).not.toMatch(/edit 42/);
  });

  it('`schedule` n est PAS exige : il vaut `always` par defaut', async () => {
    const fw = fortigate();
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 1',
      ...COMPLETE_V4.filter(l => !l.startsWith('set schedule ')), 'next',
    ]);

    expect(sorties[sorties.length - 1]).not.toMatch(REFUS);
  });

  it('`end` refuse aussi, pas seulement `next`', async () => {
    const fw = fortigate();
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 7', 'set srcintf "port1"', 'end',
    ]);

    expect(sorties[sorties.length - 1]).toMatch(REFUS);
  });
});

describe('une politique IPv6 se declare par la paire v6', () => {
  const COMPLETE_V6 = [
    'set srcintf "port1"', 'set dstintf "wan1"',
    'set srcaddr6 "all"', 'set dstaddr6 "all"',
    'set schedule "always"', 'set service "ALL"',
  ];

  it('la paire v6 SUFFIT — la paire v4 n est pas exigee', async () => {
    const fw = fortigate();
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 1', ...COMPLETE_V6, 'next',
    ]);

    expect(sorties[sorties.length - 1]).not.toMatch(REFUS);
  });

  it('et la politique v6 parait dans la configuration', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1', ...COMPLETE_V6, 'next', 'end',
    ]);

    expect(await fw.executeCommand('show firewall policy')).toMatch(/edit 1/);
  });

  it('mais sans AUCUNE source, v4 ni v6, la politique est refusee', async () => {
    const fw = fortigate();
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"', 'set dstaddr "all"',
      'set schedule "always"', 'set service "ALL"', 'next',
    ]);

    expect(sorties[sorties.length - 1]).toMatch(REFUS);
  });

  it('melanger source v6 et destination v4 est accepte', async () => {
    const fw = fortigate();
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr6 "all"', 'set dstaddr "all"',
      'set schedule "always"', 'set service "ALL"', 'next',
    ]);

    expect(sorties[sorties.length - 1]).not.toMatch(REFUS);
  });
});

describe('`abort` ne declenche AUCUN controle', () => {
  it('une politique incomplete s abandonne sans refus', async () => {
    const fw = fortigate();
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 1', 'set srcintf "port1"', 'abort',
    ]);

    expect(sorties[sorties.length - 1]).not.toMatch(REFUS);
  });

  it('et rien n est cree', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1', 'set srcintf "port1"', 'abort',
    ]);

    expect(await fw.executeCommand('show firewall policy')).not.toMatch(/edit 1/);
  });
});

describe('une politique EXISTANTE et complete se remodifie', () => {
  it('rouvrir puis `next` sans rien changer passe', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1', ...COMPLETE_V4, 'next', 'end',
    ]);
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 1', 'set action accept', 'next',
    ]);

    expect(sorties[sorties.length - 1]).not.toMatch(REFUS);
  });

  it('et `unset srcaddr` la rend a nouveau refusable', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1', ...COMPLETE_V4, 'next', 'end',
    ]);
    const sorties = await taper(fw, [
      'config firewall policy', 'edit 1', 'unset srcaddr', 'next',
    ]);

    expect(sorties[sorties.length - 1]).toMatch(REFUS);
  });
});
