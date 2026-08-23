/**
 * Sept familles acceptees par un commutateur VRP, plusieurs honorees, et
 * aucune rendue par `display current-configuration` : toutes perdues au
 * rechargement d'une topologie.
 *
 * Discrimine par `git stash` des trois fichiers de comportement : 8 des
 * 10 cas tombent. Les 2 qui passent des deux cotes sont nommes ici
 * plutot que laisses a decouvrir — « la configuration rendue par la
 * copie est la MEME », qui avant correctif compare deux configurations
 * ou aucune des familles ne figure (une tautologie, et une vraie
 * assertion une fois qu'elles y sont) ; et le TEMOIN routeur, dont
 * l'objet est justement de passer des deux cotes puisque le routeur, lui,
 * rendait deja `info-center`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { replayVendorConfig } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

async function taper(d: unknown, lignes: readonly string[]): Promise<void> {
  for (const l of lignes) await run(d, l);
}

const rejouer = (cible: unknown, configuration: string) =>
  replayVendorConfig(cible as Parameters<typeof replayVendorConfig>[0], configuration);

const LABO = [
  'system-view',
  'dhcp enable',
  'dhcp snooping enable',
  'observe-port 1 interface GigabitEthernet0/0/8',
  'info-center enable',
  'info-center loghost 10.0.0.9',
  'vlan 10', 'quit',
  'interface Vlanif10', 'ip address 10.0.0.1 255.255.255.0', 'quit',
  'ip route-static 192.168.9.0 255.255.255.0 10.0.0.9',
  'user-interface vty 0 4', 'idle-timeout 10 0', 'quit',
];

async function configure(): Promise<{ sw: HuaweiSwitch; texte: string }> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 10, 0, 0);
  await taper(sw, LABO);
  const texte = await run(sw, 'display current-configuration');
  return { sw, texte };
}

describe('ce que la machine accepte et honore figure dans sa configuration', () => {
  it('`dhcp enable` y figure', async () => {
    const { texte } = await configure();
    expect(texte).toContain('dhcp enable');
  });

  it('`dhcp snooping enable` y figure', async () => {
    const { texte } = await configure();
    expect(texte).toContain('dhcp snooping enable');
  });

  it('`observe-port` y figure, avec son index et son interface', async () => {
    const { texte } = await configure();
    expect(texte).toContain('observe-port 1 interface GigabitEthernet0/0/8');
  });

  it('`info-center` y figure, drapeau et collecteur', async () => {
    const { texte } = await configure();
    expect(texte).toContain('info-center loghost 10.0.0.9');
  });

  it('`ip route-static` y figure', async () => {
    const { texte } = await configure();
    expect(texte).toContain('ip route-static 192.168.9.0 255.255.255.0 10.0.0.9');
  });

  it('la vue `user-interface vty` y figure avec ses reglages', async () => {
    const { texte } = await configure();
    expect(texte).toContain('user-interface vty 0 4');
    expect(texte).toContain('idle-timeout 10 0');
  });
});

describe('la configuration rendue REMET la machine dans le meme etat', () => {
  it('une machine neuve qui la rejoue retrouve le snooping et le DHCP', async () => {
    const { texte } = await configure();
    const neuve = new HuaweiSwitch('switch-huawei', 'SW2', 10, 0, 0);
    await rejouer(neuve, texte);

    expect(await run(neuve, 'display dhcp snooping')).toContain('Enable');
    expect(await run(neuve, 'display observe-port')).toContain('GigabitEthernet0/0/8');
  });

  it('elle retrouve la route statique', async () => {
    const { texte } = await configure();
    const neuve = new HuaweiSwitch('switch-huawei', 'SW2', 10, 0, 0);
    await rejouer(neuve, texte);
    expect(await run(neuve, 'display ip routing-table')).toContain('192.168.9.0/24');
  });

  it('la configuration rendue par la copie est la MEME', async () => {
    const { texte } = await configure();
    const neuve = new HuaweiSwitch('switch-huawei', 'SW2', 10, 0, 0);
    await rejouer(neuve, texte);
    const rendu = (await run(neuve, 'display current-configuration'))
      .replace(/^sysname .*$/m, 'sysname SW1');
    expect(rendu).toBe(texte);
  });
});

describe('le routeur VRP rend la meme famille, avec le meme rendu', () => {
  it('`info-center loghost` figure aussi dans la configuration du routeur', async () => {
    const r = new HuaweiRouter('R1', 0, 0);
    await taper(r, ['system-view', 'info-center enable', 'info-center loghost 10.0.0.9']);
    expect(await run(r, 'display current-configuration'))
      .toContain('info-center loghost 10.0.0.9');
  });
});
