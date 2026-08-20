import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  client: LinuxPC;
  lxsrv: LinuxServer;
  winsrv: WindowsPC;
  sw: CiscoSwitch;
}

async function buildLab(): Promise<Lab> {
  const sw = new CiscoSwitch('switch-cisco', 'audit-sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'analyst', 0, 0);
  const lxsrv = new LinuxServer('linux-server', 'srv-lin', 0, 0);
  const winsrv = new WindowsPC('windows-server', 'srv-win', 0, 0);
  new Cable('cA').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('cB').connect(lxsrv.getPorts()[0], sw.getPorts()[1]);
  new Cable('cC').connect(winsrv.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  lxsrv.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), mask);
  winsrv.getPorts()[0].configureIP(new IPAddress('10.0.0.30'), mask);
  client.setHostname('analyst');
  lxsrv.setHostname('srv-lin');

  const um = (lxsrv as unknown as { executor: { userMgr: {
    useradd: (u: string, o?: object) => void;
    setPassword: (u: string, p: string) => void;
    getUser: (u: string) => unknown;
  } } }).executor.userMgr;
  if (!um.getUser('alice')) {
    um.useradd('alice', { m: true, s: '/bin/bash' });
    um.setPassword('alice', 'wonderland');
  }
  lxsrv.getSshServerContext();
  return { client, lxsrv, winsrv, sw };
}

describe('Scenario 10 — Audit centralisé des accès SSH multi-équipements', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('connexion légitime SSH Linux→Linux est enregistrée dans /var/log/auth.log avec user, IP source et méthode', async () => {
    const { client, lxsrv } = await buildLab();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.20 "uname -a"',
      'alice\n',
    );
    const log = await lxsrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice from 10\.0\.0\.10/);
    expect(log).toMatch(/sshd\[\d+\]:/);
  });

  it('tentative refusée laisse une trace "Failed password" sur le serveur', async () => {
    const { client, lxsrv } = await buildLab();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new -o NumberOfPasswordPrompts=1 alice@10.0.0.20 "id"',
      'wrong\n',
    );
    const log = await lxsrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Failed password for alice from 10\.0\.0\.10/);
  });

  it('transfert SFTP enregistre une session sftp dans auth.log', async () => {
    const { client, lxsrv } = await buildLab();
    await client.executeCommand('echo "audit-payload" > /tmp/audit.txt');
    await client.executeCommand(
      `sftp -o StrictHostKeyChecking=accept-new alice@10.0.0.20 <<'EOF'\nput /tmp/audit.txt audit.txt\nbye\nEOF`,
      'alice\n',
    );
    const log = await lxsrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice from 10\.0\.0\.10/);
    expect(log).toMatch(/subsystem request for sftp by user alice|session opened for user alice/);
  });

  it('SSH Linux→Windows produit un événement de logon Security 4624 côté Windows', async () => {
    const { client, winsrv } = await buildLab();
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new User@10.0.0.30 "hostname"',
      'password\n',
    );
    const events = await winsrv.executeCommand('wevtutil qe Security /c:20 /f:text');
    expect(events).toMatch(/4624|successfully logged on/i);
  });

  it('le switch Cisco voit les MACs des trois hôtes sur les bonnes interfaces, permettant la corrélation L2↔L3', async () => {
    const { client, lxsrv, winsrv, sw } = await buildLab();
    await client.executeCommand('ping -c 1 10.0.0.20');
    await client.executeCommand('ping -c 1 10.0.0.30');
    await lxsrv.executeCommand('ping -c 1 10.0.0.10');
    await sw.executeCommand('enable');
    const clientMac = client.getPorts()[0].getMAC().toString().toLowerCase();
    const lxMac = lxsrv.getPorts()[0].getMAC().toString().toLowerCase();
    const winMac = winsrv.getPorts()[0].getMAC().toString().toLowerCase();
    const mac = (await sw.executeCommand('show mac address-table')).toLowerCase();
    expect(mac).toContain(clientMac);
    expect(mac).toContain(lxMac);
    expect(mac).toContain(winMac);

    const counters = await sw.executeCommand('show interfaces counters');
    expect(counters).toMatch(/InOctets|InUcastPkts/i);
    const nonZero = counters.split('\n').slice(1)
      .map(l => l.trim().split(/\s+/))
      .filter(cols => cols.length >= 5 && Number(cols[2]) > 0);
    expect(nonZero.length).toBeGreaterThanOrEqual(2);
  });

  it('un analyste peut reconstruire la session: même user dans auth.log, même MAC dans la table du switch, même IP côté client', async () => {
    const { client, lxsrv, sw } = await buildLab();
    await client.executeCommand('ping -c 1 10.0.0.20');
    await sw.executeCommand('enable');
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.20 "whoami"',
      'alice\n',
    );
    const log = await lxsrv.executeCommand('cat /var/log/auth.log');
    const m = log.match(/Accepted password for (\w+) from (\d+\.\d+\.\d+\.\d+)/);
    expect(m).not.toBeNull();
    const [, user, srcIp] = m!;
    expect(user).toBe('alice');
    expect(srcIp).toBe('10.0.0.10');

    const clientIp = client.getPorts()[0].getIPAddress()?.toString();
    expect(clientIp).toBe(srcIp);

    const clientMac = client.getPorts()[0].getMAC().toString().toLowerCase();
    const macTable = (await sw.executeCommand('show mac address-table')).toLowerCase();
    expect(macTable).toContain(clientMac);
  });
});
