import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { replayVendorConfig } from '@/store/topologySerializer';

async function maquetteVrp() {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 0, 0);
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4, 0, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/0')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
  await pc1.executeCommand('ifconfig eth0 192.168.1.10');
  await pc2.executeCommand('ifconfig eth0 192.168.1.20');
  return { pc1, pc2, sw };
}

async function taper(sw: HuaweiSwitch | CiscoSwitch, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await sw.executeCommand(c));
  return out;
}

function macVrp(pc: LinuxPC): string {
  return pc.getPort('eth0')!.getMAC().toString()
    .replace(/:/g, '').match(/.{4}/g)!.join('-');
}

describe('l\'interrupteur d\'apprentissage MAC', () => {
  let lab: Awaited<ReturnType<typeof maquetteVrp>>;
  beforeEach(async () => { lab = await maquetteVrp(); });

  it('un port qui n\'apprend plus laisse la table vide, et le trafic passe quand meme', async () => {
    const { pc1, sw } = lab;
    await taper(sw, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'mac-address learning disable', 'return',
    ]);
    sw.clearMACTable();

    const out = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(out).toMatch(/1 received/);
    expect(sw.getMACTable().some(e => e.port === 'GigabitEthernet0/0/0')).toBe(false);
    expect(sw.getMACTable().some(e => e.port === 'GigabitEthernet0/0/1')).toBe(true);
  });

  it('`action discard` JETTE la trame d\'une source inconnue', async () => {
    const { pc1, sw } = lab;
    await taper(sw, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'mac-address learning disable action discard', 'return',
    ]);
    sw.clearMACTable();

    const out = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(out).toMatch(/100% packet loss/);
    expect(sw.getMACTable()).toHaveLength(0);
  });

  it('`action discard` LAISSE passer la source deja connue — le cas du serveur epingle', async () => {
    const { pc1, pc2, sw } = lab;
    sw.clearMACTable();
    sw.addStaticMAC(pc1.getPort('eth0')!.getMAC().toString().toLowerCase(), 1, 'GigabitEthernet0/0/0');
    await taper(sw, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'mac-address learning disable action discard', 'return',
    ]);

    const out = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(out).toMatch(/1 received/);
    expect(pc2).toBeDefined();
  });

  it('le meme interrupteur existe en vue VLAN, et vaut pour tous ses ports', async () => {
    const { pc1, sw } = lab;
    await taper(sw, ['system-view', 'vlan 1', 'mac-address learning disable action discard', 'return']);
    sw.clearMACTable();

    const out = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(out).toMatch(/100% packet loss/);
    expect(sw.isMacLearningEnabled('GigabitEthernet0/0/1', 1)).toBe(false);
  });

  it('le port et le VLAN se combinent, et `discard` l\'emporte sur `forward`', async () => {
    const { sw } = lab;
    await taper(sw, [
      'system-view',
      'interface GigabitEthernet0/0/0', 'mac-address learning disable', 'quit',
      'vlan 1', 'mac-address learning disable action discard', 'quit',
    ]);
    expect(sw.macLearningAction('GigabitEthernet0/0/0', 1)).toBe('discard');
    expect(sw.isMacLearningEnabled('GigabitEthernet0/0/2', 1)).toBe(false);
    expect(sw.macLearningAction('GigabitEthernet0/0/2', 1)).toBe('discard');
  });

  it('`undo` rend l\'apprentissage, et le port reapprend pour de vrai', async () => {
    const { pc1, sw } = lab;
    await taper(sw, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'mac-address learning disable action discard',
      'undo mac-address learning disable', 'return',
    ]);
    sw.clearMACTable();
    expect(sw.isMacLearningEnabled('GigabitEthernet0/0/0', 1)).toBe(true);

    const out = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(out).toMatch(/1 received/);
    expect(sw.getMACTable().some(e => e.port === 'GigabitEthernet0/0/0')).toBe(true);
  });

  it('une entree dynamique deja apprise n\'est plus RAFRAICHIE une fois l\'apprentissage coupe', async () => {
    const { pc1, sw } = lab;
    await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    const avant = sw.getMACTable().find(e => e.port === 'GigabitEthernet0/0/0')!;
    const marque = avant.timestamp;
    await taper(sw, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'mac-address learning disable', 'return',
    ]);
    await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(sw.getMACTable().find(e => e.port === 'GigabitEthernet0/0/0')!.timestamp).toBe(marque);
  });

  it('la configuration rendue porte les deux portees et se rejoue', async () => {
    const { sw } = lab;
    await taper(sw, [
      'system-view',
      'vlan 20', 'mac-address learning disable action discard', 'quit',
      'interface GigabitEthernet0/0/0', 'mac-address learning disable', 'quit',
      'interface GigabitEthernet0/0/1', 'mac-address learning disable action discard', 'return',
    ]);
    const texte = await sw.executeCommand('display current-configuration');
    const lignes = texte.split('\n').filter(l => l.includes('learning'));
    expect(lignes).toEqual([
      ' mac-address learning disable action discard',
      ' mac-address learning disable',
      ' mac-address learning disable action discard',
    ]);

    const copie = new HuaweiSwitch('switch-huawei', 'SW2', 4, 0, 0);
    await replayVendorConfig(copie, texte);
    expect(copie.getMacLearningDisabledVlans()).toEqual([[20, 'discard']]);
    expect(copie.getMacLearningDisabledPorts()).toEqual([
      ['GigabitEthernet0/0/0', 'forward'],
      ['GigabitEthernet0/0/1', 'discard'],
    ]);
  });

  it('une action inconnue est refusee en la DESIGNANT', async () => {
    const { sw } = lab;
    const [, , sortie] = await taper(sw, [
      'system-view', 'interface GigabitEthernet0/0/0',
      'mac-address learning disable action zzz',
    ]);
    expect(sortie).toContain('Unrecognized command');
    expect(sortie.split('\n')[2].indexOf('^'))
      .toBe('mac-address learning disable action '.length);
    expect(sw.isMacLearningEnabled('GigabitEthernet0/0/0', 1)).toBe(true);
  });

  it('un port neuf apprend, et la configuration ne dit rien', async () => {
    const { sw } = lab;
    expect(sw.isMacLearningEnabled('GigabitEthernet0/0/0', 1)).toBe(true);
    expect(sw.macLearningAction('GigabitEthernet0/0/0', 1)).toBe('forward');
    expect(await sw.executeCommand('display current-configuration')).not.toContain('learning');
  });
});

describe('le meme interrupteur, cote Cisco', () => {
  async function maquetteCisco() {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');
    await taper(sw, ['enable', 'configure terminal']);
    return { pc1, pc2, sw };
  }

  it('`no mac address-table learning vlan 1` coupe l\'apprentissage sans couper le trafic', async () => {
    const { pc1, sw } = await maquetteCisco();
    expect(await sw.executeCommand('no mac address-table learning vlan 1')).toBe('');
    await sw.executeCommand('end');
    sw.clearMACTable();

    const out = await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.20');
    expect(out).toMatch(/1 received/);
    expect(sw.getMACTable()).toHaveLength(0);
  });

  it('la forme par interface, son rendu et son retour', async () => {
    const { sw } = await maquetteCisco();
    await sw.executeCommand('no mac address-table learning interface FastEthernet0/1');
    await sw.executeCommand('end');
    expect(await sw.executeCommand('show running-config'))
      .toContain('no mac address-table learning interface FastEthernet0/1');

    await taper(sw, ['configure terminal', 'mac address-table learning interface FastEthernet0/1', 'end']);
    expect(sw.isMacLearningEnabled('FastEthernet0/1', 1)).toBe(true);
    expect(await sw.executeCommand('show running-config')).not.toContain('learning');
  });

  it('un VLAN ou une interface qui n\'existe pas est refuse', async () => {
    const { sw } = await maquetteCisco();
    expect(await sw.executeCommand('no mac address-table learning vlan 9999'))
      .toContain('% Invalid input');
    expect(await sw.executeCommand('no mac address-table learning interface FastEthernet0/9'))
      .toContain('% Invalid input');
    expect(await sw.executeCommand('no mac address-table learning'))
      .toContain('% Incomplete command');
  });
});
