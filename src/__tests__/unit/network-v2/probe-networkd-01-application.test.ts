/**
 * Probes — systemd-networkd applique enfin ce qu'il lit.
 *
 * Phases 1 à 6 de `docs/PRD-networkd.md`.
 *
 * Le défaut d'origine : un `.network` écrit à la main était correctement
 * NOMMÉ par `networkctl status`, et sans le moindre effet. L'adresse
 * n'était pas posée, la route pas installée, le MTU pas changé, le DNS
 * pas propagé. Le démon lisait sa configuration et n'en faisait rien.
 *
 * Le test central corrèle deux commandes — `ip -br addr` et
 * `networkctl status` — plutôt que de figer une chaîne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 30_000;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Lab {
  pc: LinuxPC;
  ecrire(chemin: string, contenu: string): void;
  redemarrer(): Promise<void>;
}

async function lab(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  pc.powerOn();
  sw.powerOn();
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);

  const vfs = (pc as unknown as {
    executor: { vfs: { createFileAt(p: string, c: string, m: number, u: number, g: number): unknown } };
  }).executor.vfs;

  return {
    pc,
    ecrire: (chemin, contenu) => { vfs.createFileAt(chemin, contenu, 0o644, 0, 0); },
    redemarrer: async () => {
      await pc.executeCommand('sudo systemctl restart systemd-networkd');
      await pause(200);
    },
  };
}

const RESEAU_STATIQUE = [
  '[Match]', 'Name=eth0', '',
  '[Network]',
  'Address=192.168.50.10/24',
  'Gateway=192.168.50.1',
  'DNS=9.9.9.9',
  'Domains=lab.local', '',
  '[Route]', 'Destination=10.20.0.0/16', 'Gateway=192.168.50.254', '',
  '[Link]', 'MTUBytes=1400', '',
].join('\n');

describe('Scénario 1 — le démon applique le fichier natif', () => {
  it('l\'adresse déclarée est réellement posée sur le lien', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    expect(
      await pc.executeCommand('ip -br addr'),
      'prémisse : eth0 n\'a aucune adresse avant que le démon agisse',
    ).not.toContain('192.168.50.10');

    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    expect(await pc.executeCommand('ip -br addr')).toContain('192.168.50.10/24');
  }, LONG);

  it('ip et networkctl s\'accordent sur l\'adresse posée', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    const parIp = /eth0\s+\S+\s+(\S+)/.exec(await pc.executeCommand('ip -br addr'))?.[1];
    const parNetworkctl = await pc.executeCommand('networkctl status eth0');

    expect(parIp).toBe('192.168.50.10/24');
    expect(
      parNetworkctl,
      'les deux commandes lisent le même lien, elles ne peuvent pas diverger',
    ).toContain(parIp!);
  }, LONG);

  it('la passerelle et la route déclarées entrent dans la table', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    const routes = await pc.executeCommand('ip route');
    expect(routes).toContain('default via 192.168.50.1');
    expect(routes).toContain('10.20.0.0/16 via 192.168.50.254');
  }, LONG);

  it('rejouer le même plan n\'empile pas de doublon', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();
    await redemarrer();
    await pc.executeCommand('sudo networkctl reload');
    await pause(150);

    const occurrences = (await pc.executeCommand('ip route'))
      .split('\n').filter((l) => l.includes('10.20.0.0/16')).length;
    expect(occurrences, 'le noyau refuse un doublon, le démon aussi').toBe(1);
  }, LONG);

  it('chaque effet est tracé au journal du démon', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    const journal = await pc.executeCommand('sudo journalctl -u systemd-networkd');
    expect(journal).toContain('192.168.50.10/24');
    expect(journal).toContain('MTU set to 1400');
  }, LONG);
});

describe('Scénario 2 — `[Link]` : MTU et MAC', () => {
  it('MTUBytes change le MTU du lien, visible par ip et networkctl', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    expect(await pc.executeCommand('ip -br link')).toContain('mtu 1400');
    expect(await pc.executeCommand('networkctl status eth0')).toMatch(/MTU: 1400/);
  }, LONG);

  it('MACAddress remplace l\'adresse matérielle', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', [
      '[Match]', 'Name=eth0', '',
      '[Link]', 'MACAddress=02:aa:bb:cc:dd:ee', '',
    ].join('\n'));
    await redemarrer();

    expect(await pc.executeCommand('ip -br link')).toContain('02:aa:bb:cc:dd:ee');
  }, LONG);

  it('ActivationPolicy=down descend le lien au lieu de le monter', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    expect(pc.getPort('eth0')!.getIsUp()).toBe(true);

    ecrire('/etc/systemd/network/10-eth0.network', [
      '[Match]', 'Name=eth0', '',
      '[Link]', 'ActivationPolicy=down', '',
    ].join('\n'));
    await redemarrer();

    expect(pc.getPort('eth0')!.getIsUp()).toBe(false);
  }, LONG);
});

describe('Scénario 3 — DNS', () => {
  it('DNS= et Domains= atterrissent dans resolv.conf', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    const resolv = await pc.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 9.9.9.9');
    expect(resolv).toContain('search lab.local');
    expect(resolv, 'le fichier annonce qui le gère').toContain('systemd-networkd');
  }, LONG);

  it('networkctl montre le résolveur que le système utilise vraiment', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    expect(await pc.executeCommand('networkctl status eth0')).toContain('9.9.9.9');
  }, LONG);
});

describe('Scénario 4 — le cycle de vie du démon compte', () => {
  it('démon arrêté, la configuration des liens n\'est plus aboutie', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();
    expect(await pc.executeCommand('networkctl list')).toMatch(/eth0\s+ether\s+routable\s+configured/);

    await pc.executeCommand('sudo systemctl stop systemd-networkd');
    await pause(150);

    expect(
      await pc.executeCommand('networkctl list'),
      'plus personne ne configure : la configuration est en attente',
    ).toMatch(/eth0\s+ether\s+routable\s+pending/);
  }, LONG);

  it('arrêter le démon ne retire pas les adresses déjà posées', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    await pc.executeCommand('sudo systemctl stop systemd-networkd');
    await pause(150);

    expect(
      await pc.executeCommand('ip -br addr'),
      'une adresse est un état du noyau ; le démon ne la nettoie pas en partant',
    ).toContain('192.168.50.10/24');
  }, LONG);

  it('`networkctl reload` relit le fichier natif, pas seulement le netplan', async () => {
    const { pc, ecrire } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);

    await pc.executeCommand('sudo networkctl reload');
    await pause(200);

    expect(await pc.executeCommand('ip -br addr')).toContain('192.168.50.10/24');
  }, LONG);

  it('`networkctl reconfigure` réapplique le seul lien visé', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    await pc.executeCommand('sudo ip addr flush dev eth0');
    await pc.executeCommand('sudo networkctl reconfigure eth0');
    await pause(150);

    expect(await pc.executeCommand('ip -br addr')).toContain('192.168.50.10/24');
  }, LONG);
});

describe('Scénario 5 — précédence entre natif et netplan', () => {
  it('un lien sans .network garde le comportement netplan, inchangé', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    const eth1 = (await pc.executeCommand('networkctl list'))
      .split('\n').find((l) => l.includes('eth1'));
    expect(
      eth1,
      'eth1 n\'est retenu par aucun .network : il reste sur le chemin netplan',
    ).toMatch(/configuring/);
  }, LONG);

  it('le .network gouverne son lien et le netplan ne le reconfigure pas', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    const status = await pc.executeCommand('networkctl status eth0');
    expect(status).toContain('/etc/systemd/network/10-eth0.network');
    expect(
      status,
      'l\'adresse vient du fichier natif, pas du DHCP que déclare le netplan',
    ).toMatch(/Address Source: static/);
  }, LONG);

  it('le premier fichier dans l\'ordre des noms gouverne, sans fusion', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/50-tardif.network', [
      '[Match]', 'Name=eth0', '', '[Network]', 'Address=172.16.0.1/24', '',
    ].join('\n'));
    ecrire('/etc/systemd/network/10-premier.network', [
      '[Match]', 'Name=eth0', '', '[Network]', 'Address=192.168.99.1/24', '',
    ].join('\n'));
    await redemarrer();

    const addr = await pc.executeCommand('ip -br addr');
    expect(addr).toContain('192.168.99.1/24');
    expect(addr, 'systemd ne fusionne pas deux .network pour un même lien').not.toContain('172.16.0.1');
  }, LONG);
});

describe('Scénario 6 — DHCP piloté par fichier', () => {
  it('`DHCP=yes` lance le client sur ce lien', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', [
      '[Match]', 'Name=eth0', '', '[Network]', 'DHCP=yes', '',
    ].join('\n'));
    await redemarrer();

    expect(
      await pc.executeCommand('sudo journalctl -u systemd-networkd'),
      'le démon doit avoir démarré le client, pas seulement lu le mot',
    ).toContain('DHCPv4 client started');
  }, LONG);

  it('un fichier statique ne déclenche aucun bail', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/10-eth0.network', RESEAU_STATIQUE);
    await redemarrer();

    expect(await pc.executeCommand('sudo journalctl -u systemd-networkd'))
      .not.toContain('DHCPv4 client started');
  }, LONG);
});

describe('Scénario 7 — `.netdev` : les liens virtuels par fichier', () => {
  it('un netdev dummy est créé au démarrage du démon', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    expect(await pc.executeCommand('ip -br link')).not.toContain('dummy0');

    ecrire('/etc/systemd/network/20-dummy.netdev', [
      '[NetDev]', 'Name=dummy0', 'Kind=dummy', '',
    ].join('\n'));
    await redemarrer();

    expect(await pc.executeCommand('ip -br link')).toContain('dummy0');
  }, LONG);

  it('un type que le simulateur ne sait pas créer est ignoré, pas simulé', async () => {
    const { pc, ecrire, redemarrer } = await lab();
    ecrire('/etc/systemd/network/20-bond.netdev', [
      '[NetDev]', 'Name=bond0', 'Kind=bond', '',
    ].join('\n'));
    await redemarrer();

    expect(
      await pc.executeCommand('ip -br link'),
      'annoncer un bond sans modèle serait un mensonge — voir PRD §6',
    ).not.toContain('bond0');
  }, LONG);
});
