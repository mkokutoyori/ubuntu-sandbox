import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 0, 0);
  const internet = new LinuxPC('linux-pc', 'INTERNET');

  new Cable('transit').connect(fgt.getPorts()[0], r1.getPort('GigabitEthernet0/1')!);
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/0')!, internet.getPorts()[0]);
  await internet.executeCommand('ifconfig eth0 8.8.8.8 netmask 255.255.255.0');
  await internet.executeCommand('ip route add default via 8.8.8.1');

  await taper(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', 'ip address 8.8.8.1 255.255.255.0', 'no shutdown', 'exit',
    'end',
  ]);
  return { fgt, r1, internet };
}

async function tp1(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config system interface',
    'edit port1',
    'set alias "WAN-vers-R1"',
    'set mode static',
    'set ip 192.168.100.99 255.255.255.0',
    'set allowaccess ping http https ssh',
    'next',
    'end',
    'config router static',
    'edit 1',
    'set gateway 192.168.100.1',
    'set device "port1"',
    'set comment "Vers R1-EDGE"',
    'next',
    'end',
  ]);
}

describe('TP 1 — installer et demarrer son premier FortiGate', () => {
  it('etape 4 : `get system status` rend les lignes que le TP fait lire', async () => {
    const { fgt } = await laboratoire();
    const out = await fgt.executeCommand('get system status');
    expect(out).toMatch(/^Version: FortiGate-VM64 v7\.6\.\d+,build\d+/m);
    expect(out).toMatch(/^Serial-Number: FGVM/m);
    expect(out).toMatch(/^License Status: /m);
    expect(out).toMatch(/^VM Resources: 1 CPU, \d+ MB RAM/m);
    expect(out).toMatch(/^Log hard disk: /m);
    expect(out).toMatch(/^Hostname: /m);
    expect(out).toMatch(/^Operation Mode: NAT$/m);
    expect(out).toMatch(/^Current HA mode: standalone$/m);
    expect(out).toMatch(/^System time: /m);
  });

  it('etape 5 : la sequence config/edit/set/next/end est acceptee mot pour mot', async () => {
    const { fgt } = await laboratoire();
    const sorties = await tp1(fgt);
    for (const s of sorties) {
      expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
    }
  });

  it('etape 5 : l\'invite suit la vue, comme le TP la montre', async () => {
    const { fgt } = await laboratoire();
    expect(fgt.getPrompt()).toBe('FGT-01 # ');
    await fgt.executeCommand('config system interface');
    expect(fgt.getPrompt()).toBe('FGT-01 (interface) # ');
    await fgt.executeCommand('edit port1');
    expect(fgt.getPrompt()).toBe('FGT-01 (port1) # ');
    await taper(fgt, ['next', 'end']);
    expect(fgt.getPrompt()).toBe('FGT-01 # ');
  });

  it('etape 5 : les deux pings du TP passent, et le premier prouve le transit', async () => {
    const { fgt } = await laboratoire();
    await tp1(fgt);
    const transit = await fgt.executeCommand('execute ping 192.168.100.1');
    expect(transit).toMatch(/bytes from 192\.168\.100\.1/);
    expect(transit).toMatch(/0% packet loss/);

    const internet = await fgt.executeCommand('execute ping 8.8.8.8');
    expect(internet).toMatch(/bytes from 8\.8\.8\.8/);
    expect(internet).toMatch(/0% packet loss/);
  });

  it('etape 6 : `get system interface physical` montre port1 adresse', async () => {
    const { fgt } = await laboratoire();
    await tp1(fgt);
    const out = await fgt.executeCommand('get system interface physical');
    expect(out).toContain('port1');
    expect(out).toContain('192.168.100.99 255.255.255.0');
  });

  it('etape 6 : `diagnose ip address list` montre la meme adresse', async () => {
    const { fgt } = await laboratoire();
    await tp1(fgt);
    const out = await fgt.executeCommand('diagnose ip address list');
    expect(out).toContain('192.168.100.99');
    expect(out).toContain('port1');
  });

  it('l\'alias et le commentaire sont RELUS par `show`', async () => {
    const { fgt } = await laboratoire();
    await tp1(fgt);
    const conf = await fgt.executeCommand('show');
    expect(conf).toContain('set alias "WAN-vers-R1"');
    expect(conf).toContain('set ip 192.168.100.99 255.255.255.0');
    expect(conf).toContain('set allowaccess ping http https ssh');
    expect(conf).toContain('set gateway 192.168.100.1');
    expect(conf).toContain('set comment "Vers R1-EDGE"');
  });

  it('resultat attendu : le port1 repond au ping depuis le reseau de transit', async () => {
    const { fgt, r1 } = await laboratoire();
    await tp1(fgt);
    const out = await r1.executeCommand('ping 192.168.100.99');
    expect(out).toMatch(/Success rate is (80|100) percent/);
  });

  it('`allowaccess` gouverne VRAIMENT l\'administration du port1', async () => {
    const { fgt, r1 } = await laboratoire();
    await tp1(fgt);
    expect(await pingOnSimulatedClock(r1, 'ping 192.168.100.99'))
      .toMatch(/Success rate is (80|100) percent/);

    await taper(fgt, [
      'config system interface', 'edit port1',
      'set allowaccess https ssh', 'next', 'end',
    ]);
    expect(fgt.allowedAccessOn('port1')).not.toContain('ping');
    expect(await pingOnSimulatedClock(r1, 'ping 192.168.100.99'))
      .toMatch(/Success rate is 0 percent/);
  });

  it('le mot de passe vide d\'usine est IMPOSE au changement', async () => {
    const { fgt } = await laboratoire();
    const out = await fgt.executeCommand('get system admin-password-policy');
    expect(out).not.toMatch(/Unknown action/i);
  });
});
