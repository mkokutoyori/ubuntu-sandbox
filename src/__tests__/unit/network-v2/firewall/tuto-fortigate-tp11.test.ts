import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

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

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await srvDmz.executeCommand('systemctl start nginx');

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall policy', 'edit 1',
    'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

describe('TP 11 — comparer les deux modes d\'inspection', () => {
  it('etape 1 : le mode par defaut est `flow`, et seul `full-configuration` le montre',
    async () => {
      const { fgt } = await laboratoire();

      expect(await fgt.executeCommand('show firewall policy 1 | grep inspection'))
        .toBe('');
      expect(await fgt.executeCommand(
        'show full-configuration firewall policy 1 | grep inspection-mode'))
        .toContain('set inspection-mode flow');
    });

  it('etape 2 : un profil de filtrage web se cree avec son jeu de fonctions',
    async () => {
      const { fgt } = await laboratoire();
      propre(await taper(fgt, [
        'config webfilter profile', 'edit "WF-Flow"',
        'set feature-set flow',
        'set comment "Profil de test - mode flow"',
        'next', 'end',
      ]));
      const conf = await fgt.executeCommand('show webfilter profile WF-Flow');
      expect(conf).toContain('set feature-set flow');
      expect(conf).toContain('set comment "Profil de test - mode flow"');
    });

  it('etape 3 : le profil s\'attache a la politique', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config webfilter profile', 'edit "WF-Flow"', 'set feature-set flow', 'next', 'end',
    ]);
    propre(await taper(fgt, [
      'config firewall policy', 'edit 1',
      'set utm-status enable',
      'set inspection-mode flow',
      'set webfilter-profile "WF-Flow"',
      'set ssl-ssh-profile "certificate-inspection"',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show firewall policy 1');
    expect(conf).toContain('set utm-status enable');
    expect(conf).toContain('set webfilter-profile "WF-Flow"');
    expect(conf).toContain('set ssl-ssh-profile "certificate-inspection"');
  });

  it('etape 3 : sans `utm-status enable` le profil ne s\'attache pas', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config webfilter profile', 'edit "WF-Flow"', 'set feature-set flow', 'next', 'end',
    ]);
    await taper(fgt, ['config firewall policy', 'edit 1']);
    const refus = await fgt.executeCommand('set webfilter-profile "WF-Flow"');
    await taper(fgt, ['next', 'end']);

    expect(refus).toMatch(/does not apply/i);
    expect(fgt.getPolicyStore().byId('1')?.webFilterProfile).toBeUndefined();
  });

  it('etape 4 : un profil PROXY sur une politique FLOW est signale', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config webfilter profile', 'edit "WF-Proxy"', 'set feature-set proxy', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set utm-status enable', 'set inspection-mode flow', 'next', 'end',
    ]);

    await fgt.executeCommand('config firewall policy');
    await fgt.executeCommand('edit 1');
    await fgt.executeCommand('set webfilter-profile "WF-Proxy"');
    const verdict = await fgt.executeCommand('next');
    await fgt.executeCommand('end');

    expect(verdict).toMatch(/feature-set proxy/i);
    expect(verdict).toMatch(/inspection-mode flow/i);
  });

  it('etape 5 : la politique passee en proxy accepte le meme profil', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config webfilter profile', 'edit "WF-Proxy"', 'set feature-set proxy', 'next', 'end',
    ]);
    propre(await taper(fgt, [
      'config firewall policy', 'edit 1',
      'set utm-status enable',
      'set inspection-mode proxy',
      'set webfilter-profile "WF-Proxy"',
      'next', 'end',
    ]));
    expect(await fgt.executeCommand('show firewall policy 1'))
      .toContain('set inspection-mode proxy');
  });

  it('etape 6 : `get system performance status` rend un etat', async () => {
    const { fgt } = await laboratoire();
    const vue = await fgt.executeCommand('get system performance status');
    expect(vue).not.toMatch(/Unknown action/i);
    expect(vue).toMatch(/CPU|Memory|Uptime/i);
  });

  it('etape 6 : `diagnose sys top` liste les processus', async () => {
    const { fgt } = await laboratoire();
    const vue = await fgt.executeCommand('diagnose sys top 5 20');
    expect(vue).not.toMatch(/Unknown action/i);
    expect(vue).toContain('newcli');
  });

  it('etape 6 : `wad` traite le trafic quand une politique est en proxy', async () => {
    const { fgt, pcLan } = await laboratoire();
    await taper(fgt, [
      'config firewall policy', 'edit 1',
      'set utm-status enable', 'set inspection-mode proxy', 'next', 'end',
    ]);
    await pcLan.executeCommand('curl -sS http://192.168.20.10/');

    expect(await fgt.executeCommand('diagnose sys top 5 20')).toContain('wad');
  });

  it('etape 7 : revenir en flow se relit', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config webfilter profile', 'edit "WF-Flow"', 'set feature-set flow', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set utm-status enable', 'set inspection-mode proxy', 'next', 'end',
    ]);
    propre(await taper(fgt, [
      'config firewall policy', 'edit 1',
      'set inspection-mode flow',
      'set webfilter-profile "WF-Flow"',
      'next', 'end',
    ]));
    expect(await fgt.executeCommand('show firewall policy 1'))
      .not.toContain('set inspection-mode proxy');
  });

  it('etape 8 : supprimer un profil REFERENCE est refuse', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config webfilter profile', 'edit "WF-Proxy"', 'set feature-set proxy', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set utm-status enable', 'set inspection-mode proxy',
      'set webfilter-profile "WF-Proxy"', 'next', 'end',
    ]);

    await fgt.executeCommand('config webfilter profile');
    const refus = await fgt.executeCommand('delete "WF-Proxy"');
    await fgt.executeCommand('end');

    expect(refus).toMatch(/used by other entries/i);
  });

  it('etape 8 : le profil se supprime une fois DETACHE', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config webfilter profile', 'edit "WF-Proxy"', 'set feature-set proxy', 'next', 'end',
      'config firewall policy', 'edit 1',
      'set utm-status enable', 'set inspection-mode proxy',
      'set webfilter-profile "WF-Proxy"', 'next', 'end',
      'config firewall policy', 'edit 1', 'unset webfilter-profile', 'next', 'end',
    ]);
    propre(await taper(fgt, [
      'config webfilter profile', 'delete "WF-Proxy"', 'end',
    ]));
    expect(await fgt.executeCommand('show webfilter profile'))
      .not.toContain('WF-Proxy');
  });
});
