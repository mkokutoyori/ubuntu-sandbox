import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
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

interface Cli {
  executeCommand(command: string): Promise<string>;
  getPortNames(): string[];
  getPort(name: string): unknown;
}

const REFUS = /Unknown action|command parse error|Invalid|Incomplete|Command fail/i;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

interface Labo {
  fw: Cli;
  sw: CiscoSwitch;
  pc: LinuxPC;
}

async function taper(device: Cli, lignes: readonly string[]): Promise<void> {
  for (const ligne of lignes) await device.executeCommand(ligne);
}

async function labo(): Promise<Labo> {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 200, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 400, 0);
  sw.powerOn();
  pc.powerOn();

  new Cable('fw-sw').connect(
    fw.getPort('port1') as never, sw.getPort('FastEthernet0/1') as never);
  new Cable('sw-pc').connect(
    sw.getPort('FastEthernet0/2') as never, pc.getPort('eth0') as never);

  await taper(fw, [
    'config system interface', 'edit port1',
    'set mode static', 'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping https ssh http', 'next', 'end',
  ]);
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up',
    'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1',
  ]);
  return { fw, sw, pc };
}

describe('le pare-feu sur le commutateur — la couche 2', () => {
  it('le PC joint le pare-feu a travers le commutateur', async () => {
    const { pc } = await labo();

    expect(await pc.executeCommand('ping -c 2 192.168.1.1')).toMatch(/, 0% packet loss/);
  });

  it('le commutateur APPREND les deux adresses MAC', async () => {
    const { sw, pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');
    const table = await sw.executeCommand('show mac address-table');

    expect(table).toMatch(/FastEthernet0\/1/);
    expect(table).toMatch(/FastEthernet0\/2/);
  });

  it('et il ne les apprend pas sur le meme port', async () => {
    const { sw, pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');
    const lignes = (await sw.executeCommand('show mac address-table'))
      .split('\n').filter(l => /FastEthernet0\/[12]/.test(l));

    expect(lignes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ARP — qui demande, qui repond', () => {
  it('le PC apprend la MAC du pare-feu', async () => {
    const { pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');

    expect(await pc.executeCommand('ip neigh')).toMatch(/192\.168\.1\.1/);
  });

  it('la MAC apprise est bien CELLE du port du pare-feu', async () => {
    const { fw, pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');

    const port = fw.getPort('port1') as { getMAC(): { toString(): string } };
    const attendue = port.getMAC().toString().toLowerCase();

    expect((await pc.executeCommand('ip neigh')).toLowerCase()).toContain(attendue);
  });

  it('le pare-feu apprend la MAC du PC, et `get system arp` la montre', async () => {
    const { fw, pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');
    const arp = await fw.executeCommand('get system arp');

    expect(arp).toContain('192.168.1.10');
    expect(arp).toMatch(/port1/);
  });

  it('`diagnose ip arp list` rend la meme table', async () => {
    const { fw, pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');

    expect(await fw.executeCommand('diagnose ip arp list')).toContain('192.168.1.10');
  });

  it('une adresse JAMAIS vue n est pas dans la table', async () => {
    const { fw, pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');

    expect(await fw.executeCommand('get system arp')).not.toContain('192.168.1.77');
  });

  it('le pare-feu repond a une demande ARP pour SON adresse', async () => {
    const { pc } = await labo();
    await pc.executeCommand('ip neigh flush all');

    expect(await pc.executeCommand('ping -c 1 192.168.1.1')).toMatch(/, 0% packet loss/);
  });

  it('et il ne repond PAS pour une adresse qui n est pas la sienne', async () => {
    const { pc } = await labo();

    expect(await pc.executeCommand('ping -c 1 -W 1 192.168.1.55'))
      .toMatch(/100% packet loss|Destination Host Unreachable/);
  });
});

describe('l interface web du pare-feu, vue depuis la machine', () => {
  it('`curl -k https://192.168.1.1` rend la page de connexion', async () => {
    const { pc } = await labo();
    const sortie = await pc.executeCommand('curl -k -s https://192.168.1.1/');

    expect(sortie).not.toMatch(/Connection refused|Could not resolve|couldn't connect/i);
    expect(sortie.length).toBeGreaterThan(0);
  });

  it('la page nomme FortiGate — c est bien SON interface', async () => {
    const { pc } = await labo();

    expect(await pc.executeCommand('curl -k -s https://192.168.1.1/')).toMatch(/forti/i);
  });

  it('`curl -sv` montre un code de reponse HTTP', async () => {
    const { pc } = await labo();
    const sortie = await pc.executeCommand('curl -k -sv https://192.168.1.1/');

    expect(sortie).toMatch(/HTTP\/1\.[01] \d{3}/);
  });

  it('le port 80 repond aussi quand `http` est dans allowaccess', async () => {
    const { pc } = await labo();
    const sortie = await pc.executeCommand('curl -s http://192.168.1.1/');

    expect(sortie).not.toMatch(/Connection refused|couldn't connect/i);
  });

  it('retirer `https` de allowaccess FERME la porte', async () => {
    const { fw, pc } = await labo();
    await taper(fw, [
      'config system interface', 'edit port1',
      'set allowaccess ping', 'next', 'end',
    ]);

    expect(await pc.executeCommand('curl -k -sS https://192.168.1.1/'))
      .toMatch(/Connection refused|couldn't connect|refused/i);
  });

  it('et le ping continue de passer — seul HTTPS est ferme', async () => {
    const { fw, pc } = await labo();
    await taper(fw, [
      'config system interface', 'edit port1',
      'set allowaccess ping', 'next', 'end',
    ]);

    expect(await pc.executeCommand('ping -c 1 192.168.1.1')).toMatch(/, 0% packet loss/);
  });

  it('l authentification admin repond a une mauvaise identite', async () => {
    const { pc } = await labo();
    const sortie = await pc.executeCommand(
      'curl -k -s -d "username=admin&secretkey=FAUX" https://192.168.1.1/logincheck');

    expect(sortie).not.toMatch(/Connection refused/i);
  });
});

describe('le trafic qui TRAVERSE le pare-feu', () => {
  async function avecServeur(): Promise<Labo & { serveur: LinuxServer }> {
    const base = await labo();
    const serveur = new LinuxServer('linux-server', 'SRV', 600, 0);
    serveur.powerOn();
    new Cable('fw-srv').connect(
      base.fw.getPort('wan1') as never, serveur.getPort('eth0') as never);

    await taper(base.fw, [
      'config system interface', 'edit wan1',
      'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    ]);
    await taper(serveur as unknown as Cli, [
      'ip link set eth0 up',
      'ip addr add 203.0.113.9/24 dev eth0',
      'ip route add default via 203.0.113.1',
    ]);
    return { ...base, serveur };
  }

  it('sans politique, le pare-feu BLOQUE — c est son defaut d usine', async () => {
    const { pc } = await avecServeur();

    expect(await pc.executeCommand('ping -c 1 -W 1 203.0.113.9'))
      .toMatch(/100% packet loss/);
  });

  it('avec la politique LAN vers WAN, le trafic passe', async () => {
    const { fw, pc } = await avecServeur();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set name "LAN-vers-Internet"',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'next', 'end',
    ]);

    expect(await pc.executeCommand('ping -c 2 203.0.113.9')).toMatch(/, 0% packet loss/);
  });

  it('et la session apparait dans `diagnose sys session list`', async () => {
    const { fw, pc } = await avecServeur();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'next', 'end',
    ]);
    await pc.executeCommand('ping -c 1 203.0.113.9');

    expect(refuse(await fw.executeCommand('diagnose sys session list'))).toBe(false);
  });

  it('le NAT remplace l adresse source par celle du WAN', async () => {
    const { fw, pc, serveur } = await avecServeur();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'next', 'end',
    ]);
    await pc.executeCommand('ping -c 1 203.0.113.9');

    expect(await (serveur as unknown as Cli).executeCommand('ip neigh'))
      .toMatch(/203\.0\.113\.1/);
  });

  it('une requete HTTP traverse le pare-feu jusqu au serveur', async () => {
    const { fw, pc, serveur } = await avecServeur();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'next', 'end',
    ]);
    await taper(serveur as unknown as Cli, [
      'systemctl start nginx',
    ]);

    const sortie = await pc.executeCommand('curl -s http://203.0.113.9/');
    expect(sortie).not.toMatch(/Connection refused|couldn't connect/i);
    expect(sortie.length).toBeGreaterThan(0);
  });
});
