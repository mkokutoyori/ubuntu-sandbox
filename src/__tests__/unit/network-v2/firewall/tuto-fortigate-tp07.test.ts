import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -100, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 100, 0);

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
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'edit "NET-DMZ"', 'set subnet 192.168.20.0 255.255.255.0', 'next',
    'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

async function politiqueDmz(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config firewall policy', 'edit 2',
    'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
    'set service "PING" "HTTP"',
    'set schedule "always"', 'set action accept',
    'set logtraffic all',
    'set comments "Le LAN consulte les serveurs de la DMZ"',
    'next', 'end',
  ]);
}

async function politiqueBlocage(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config firewall policy', 'edit 3',
    'set name "BLOQUER-Ping-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
    'set service "PING"',
    'set schedule "always"', 'set action deny',
    'set logtraffic all',
    'next', 'end',
  ]);
}

describe('TP 7 — la premiere politique, et lever le blocage', () => {
  it('etape 2 : sans politique le LAN ne joint PAS la DMZ — le temoin', async () => {
    const { pcLan } = await laboratoire();
    expect(await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.20.10'))
      .toMatch(/ 100% packet loss/);
  });

  it('etape 2 : la politique LEVE le blocage, ping et HTTP', async () => {
    const { fgt, pcLan } = await laboratoire();
    propre(await politiqueDmz(fgt));

    expect(await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.20.10'))
      .toMatch(/ 0% packet loss/);
    expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/'))
      .toContain('Welcome to nginx!');
  });

  it('etape 2 : aucune politique DMZ vers LAN n\'existe, le retour passe quand meme',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await politiqueDmz(fgt);
      await pcLan.executeCommand('curl -sS http://192.168.20.10/');

      const conf = await fgt.executeCommand('show firewall policy');
      expect(conf).not.toMatch(/set srcintf "port3"/);
    });

  it('etape 3 : un service HORS de la liste est refuse', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await srvDmz.executeCommand('systemctl start ssh');
    await politiqueDmz(fgt);

    const ssh = await pcLan.executeCommand('curl -sS https://192.168.20.10/');
    expect(ssh).not.toContain('Welcome to nginx!');
  });

  it('etape 4 : une regle de blocage PLACEE APRES n\'est jamais lue', async () => {
    const { fgt, pcLan } = await laboratoire();
    await politiqueDmz(fgt);
    propre(await politiqueBlocage(fgt));

    expect(await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.20.10'))
      .toMatch(/ 0% packet loss/);
  });

  it('etape 5 : `move 3 before 2` change le comportement sans changer les regles',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await politiqueDmz(fgt);
      await politiqueBlocage(fgt);

      propre(await taper(fgt, [
        'config firewall policy', 'move 3 before 2', 'end',
      ]));

      expect(await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.20.10'))
        .toMatch(/ 100% packet loss/);
      expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/'))
        .toContain('Welcome to nginx!');
    });

  it('etape 5 : l\'ordre RENDU montre 3 avant 2', async () => {
    const { fgt } = await laboratoire();
    await politiqueDmz(fgt);
    await politiqueBlocage(fgt);
    await taper(fgt, ['config firewall policy', 'move 3 before 2', 'end']);

    const vue = await fgt.executeCommand(
      'show firewall policy | grep -e "edit " -e "set name"');
    const positions = [vue.indexOf('edit 3'), vue.indexOf('edit 2')];
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[0]).toBeLessThan(positions[1]);
  });

  it('etape 6 : la table de sessions nomme la politique qui a decide', async () => {
    const { fgt, pcLan } = await laboratoire();
    await politiqueDmz(fgt);
    await pcLan.executeCommand('curl -sS http://192.168.20.10/');

    await fgt.executeCommand('diagnose sys session filter dst 192.168.20.10');
    const vue = await fgt.executeCommand('diagnose sys session list');
    expect(vue).toContain('session info: proto=6');
    expect(vue).toContain('policy_id=2');
    expect(vue).toMatch(/statistic\(bytes\/packets\/allow_err\)/);
  });

  it('etape 7 : `diagnose sys session clear` avec filtre ne vide QUE la cible',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await politiqueDmz(fgt);
      await pcLan.executeCommand('curl -sS http://192.168.20.10/');
      await pingOnSimulatedClock(pcLan, 'ping -c 1 192.168.20.1');

      await fgt.executeCommand('diagnose sys session filter dst 192.168.20.10');
      propre(await taper(fgt, ['diagnose sys session clear']));

      await fgt.executeCommand('diagnose sys session filter dst 192.168.20.10');
      expect(await fgt.executeCommand('diagnose sys session list')).not.toContain('proto=6');
    });

  it('etape 7 : `diagnose sys session filter` sans argument RELIT le filtre', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('diagnose sys session filter dst 192.168.20.10');
    const vue = await fgt.executeCommand('diagnose sys session filter');
    expect(vue).not.toMatch(/Unknown action/i);
    expect(vue).toContain('192.168.20.10');
  });

  it('etape 8 : les journaux montrent le refus de la politique 3', async () => {
    const { fgt, pcLan } = await laboratoire();
    await politiqueDmz(fgt);
    await politiqueBlocage(fgt);
    await taper(fgt, ['config firewall policy', 'move 3 before 2', 'end']);
    await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.20.10');

    await taper(fgt, [
      'execute log filter category 0',
      'execute log filter field policyid 3',
    ]);
    const journal = await fgt.executeCommand('execute log display');
    expect(journal).toContain('policyid=3');
    expect(journal).toMatch(/action="deny"/);
  });

  it('etape 9 : `diagnose firewall iprope show` COMPTE les correspondances', async () => {
    const { fgt, pcLan } = await laboratoire();
    await politiqueDmz(fgt);

    const avant = await fgt.executeCommand('diagnose firewall iprope show 100004 2');
    expect(avant).toContain('hit count:0');

    await pcLan.executeCommand('curl -sS http://192.168.20.10/');
    const apres = await fgt.executeCommand('diagnose firewall iprope show 100004 2');
    expect(apres).not.toContain('hit count:0');
    expect(apres).toMatch(/hit count:[1-9]/);
  });

  it('etape 9 : `get firewall policy` liste les politiques dans l\'ordre', async () => {
    const { fgt } = await laboratoire();
    await politiqueDmz(fgt);
    await politiqueBlocage(fgt);

    const vue = await fgt.executeCommand('get firewall policy');
    expect(vue).toContain('== [ 2 ]');
    expect(vue).toContain('== [ 3 ]');
  });

  it('etape 10 : supprimer la politique 3 la retire de la liste', async () => {
    const { fgt } = await laboratoire();
    await politiqueDmz(fgt);
    await politiqueBlocage(fgt);
    propre(await taper(fgt, ['config firewall policy', 'delete 3', 'end']));

    expect(await fgt.executeCommand('show firewall policy'))
      .not.toContain('BLOQUER-Ping-vers-DMZ');
  });
});
