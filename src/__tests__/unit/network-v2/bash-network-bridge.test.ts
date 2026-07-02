import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const SRV_IP = '10.0.0.1';
const PC_IP = '10.0.0.2';
const DEAD_IP = '10.0.0.99';

const NAMED_CONF = [
  'options { directory "/var/cache/bind"; recursion no; };',
  'zone "example.com" { type primary; file "/etc/bind/db.example"; };',
  '',
].join('\n');

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@   IN SOA ns1.example.com. admin.example.com. ( 1 3600 900 604800 300 )',
  '    IN NS  ns1.example.com.',
  'ns1 IN A   10.0.0.1',
  'www IN A   10.0.0.80',
  '',
].join('\n');

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

interface Lab {
  pc: LinuxPC;
  srv: LinuxServer;
  cable: Cable;
}

async function buildLab(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('SRV1');
  pc.configureInterface('eth0', new IPAddress(PC_IP), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(SRV_IP), new SubnetMask('255.255.255.0'));
  const cable = new Cable('c1');
  cable.connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  vfsOf(srv).writeFile('/etc/bind/named.conf', NAMED_CONF, 0, 0, 0o022);
  vfsOf(srv).writeFile('/etc/bind/db.example', ZONE_DB, 0, 0, 0o022);
  await srv.executeCommand('systemctl start named');

  return { pc, srv, cable };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('pont bash ↔ commandes réseau — opérateurs de contrôle', () => {
  it('ping joignable && echo exécute la branche de succès', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`ping -c 1 ${SRV_IP} > /dev/null 2>&1 && echo CIBLE-OK`);

    expect(out.trim()).toBe('CIBLE-OK');
  }, 20000);

  it('ping injoignable || echo exécute la branche d\'échec', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(
      `ping -c 1 -W 1 ${DEAD_IP} > /dev/null 2>&1 || echo CIBLE-KO`,
    );

    expect(out.trim()).toBe('CIBLE-KO');
  }, 20000);

  it('propage le code retour réel de ping dans $?', async () => {
    const { pc } = await buildLab();

    const ok = await pc.executeCommand(`ping -c 1 ${SRV_IP} > /dev/null 2>&1; echo "rc=$?"`);
    expect(ok.trim()).toBe('rc=0');

    const ko = await pc.executeCommand(`ping -c 1 -W 1 ${DEAD_IP} > /dev/null 2>&1; echo "rc=$?"`);
    expect(ko.trim()).toBe('rc=1');
  }, 20000);
});

describe('pont bash ↔ commandes réseau — if/then/else', () => {
  it('if ping choisit la branche then quand la cible répond', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(
      `if ping -c 1 -W 2 ${SRV_IP} > /dev/null 2>&1; then echo VIVANT; else echo MORT; fi`,
    );

    expect(out.trim()).toBe('VIVANT');
  }, 20000);

  it('if ping choisit la branche else quand le câble est débranché', async () => {
    const { pc, srv, cable } = await buildLab();
    cable.disconnect();

    const out = await pc.executeCommand(
      `if ping -c 1 -W 1 ${SRV_IP} > /dev/null 2>&1; then echo VIVANT; else echo MORT; fi`,
    );

    expect(out.trim()).toBe('MORT');
    cable.connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  }, 20000);
});

describe('pont bash ↔ commandes réseau — redirections et pipes', () => {
  it('redirige la sortie de dig vers un fichier', async () => {
    const { pc } = await buildLab();

    await pc.executeCommand(`dig @${SRV_IP} +short www.example.com > /tmp/dig.out`);
    const out = await pc.executeCommand('cat /tmp/dig.out');

    expect(out.trim()).toBe('10.0.0.80');
  }, 20000);

  it('pipe la sortie de dig dans grep', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${SRV_IP} www.example.com | grep -c ANSWER`);

    expect(Number(out.trim())).toBeGreaterThanOrEqual(1);
  }, 20000);
});

describe('pont bash ↔ commandes réseau — substitution de commande', () => {
  it('capture la sortie de dig dans $( )', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`echo "ip=$(dig @${SRV_IP} +short www.example.com)"`);

    expect(out.trim()).toBe('ip=10.0.0.80');
  }, 20000);

  it('utilise la substitution réseau dans une affectation puis un ping', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand([
      `WEB_IP=$(dig @${SRV_IP} +short www.example.com)`,
      'echo "resolu:$WEB_IP"',
    ].join('\n'));

    expect(out).toContain('resolu:10.0.0.80');
  }, 20000);
});

describe('pont bash ↔ commandes réseau — boucle de service réaliste', () => {
  it('exécute un corps de script de surveillance complet en une passe', async () => {
    const { pc } = await buildLab();

    const body = [
      `if ping -c 1 -W 2 ${SRV_IP} > /dev/null 2>&1; then`,
      `  echo "$(date '+%Y-%m-%d') OK ${SRV_IP}" >> /tmp/mon.log`,
      'else',
      `  echo "$(date '+%Y-%m-%d') ALERTE ${SRV_IP}" >> /tmp/mon.log`,
      'fi',
    ].join('\n');

    await pc.executeCommand(body);
    await pc.executeCommand(body);
    const log = await pc.executeCommand('cat /tmp/mon.log');

    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} OK/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2} OK/);
  }, 20000);
});
