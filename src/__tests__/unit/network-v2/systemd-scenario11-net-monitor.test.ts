import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const SWITCH_IP = '192.168.10.1';
const PC_IP = '192.168.10.20';
const SCRIPT_PATH = '/usr/local/bin/net-monitor.sh';
const LOG_PATH = '/var/log/net-monitor.log';
const WANTS_LINK = '/etc/systemd/system/multi-user.target.wants/net-monitor.service';

const MONITOR_SCRIPT = [
  '#!/bin/bash',
  `echo "$(date '+%Y-%m-%d %H:%M:%S') Service net-monitor démarré" >> ${LOG_PATH}`,
  `echo "Service net-monitor démarré"`,
  'while true; do',
  `  if ping -c 1 -W 2 ${SWITCH_IP} > /dev/null 2>&1; then`,
  `    echo "$(date '+%Y-%m-%d %H:%M:%S') OK ${SWITCH_IP} joignable" >> ${LOG_PATH}`,
  `    echo "OK ${SWITCH_IP} joignable"`,
  '  else',
  `    echo "$(date '+%Y-%m-%d %H:%M:%S') ALERTE ${SWITCH_IP} injoignable" >> ${LOG_PATH}`,
  `    echo "ALERTE ${SWITCH_IP} injoignable"`,
  '  fi',
  '  sleep 1',
  'done',
  '',
].join('\n');

const UNIT_FILE = [
  '[Unit]',
  'Description=Surveillance réseau du LAN',
  'After=network.target',
  '',
  '[Service]',
  'Type=simple',
  `ExecStart=${SCRIPT_PATH}`,
  'Restart=on-failure',
  'RestartSec=0.3',
  'StandardOutput=journal',
  'StandardError=journal',
  '',
  '[Install]',
  'WantedBy=multi-user.target',
  '',
].join('\n');

function vfsOf(pc: LinuxPC): VirtualFileSystem {
  return (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Lab {
  pc: LinuxPC;
  sw: HuaweiSwitch;
  cable: Cable;
}

async function buildLab(): Promise<Lab> {
  const sw = new HuaweiSwitch('huawei-switch', 'SW1', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1');

  pc.configureInterface('eth0', new IPAddress(PC_IP), new SubnetMask('255.255.255.0'));
  const cable = new Cable('c1');
  cable.connect(pc.getPort('eth0')!, sw.getPorts()[0]);

  for (const cmd of [
    'system-view',
    'interface Vlanif1',
    `ip address ${SWITCH_IP} 255.255.255.0`,
    'undo shutdown',
    'quit',
    'quit',
  ]) {
    await sw.executeCommand(cmd);
  }

  vfsOf(pc).writeFile(SCRIPT_PATH, MONITOR_SCRIPT, 0, 0, 0o022);
  await pc.executeCommand(`sudo chmod +x ${SCRIPT_PATH}`);
  vfsOf(pc).writeFile('/etc/systemd/system/net-monitor.service', UNIT_FILE, 0, 0, 0o022);
  await pc.executeCommand('systemctl daemon-reload');

  return { pc, sw, cable };
}

function readLog(pc: LinuxPC): string {
  return vfsOf(pc).readFile(LOG_PATH) ?? '';
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe.skip('Scénario 11 — service de surveillance réseau (bloqué : pont async bash↔réseau requis)', () => {
  it('phase déploiement : script exécutable, unité chargée inactive, symlink après enable', async () => {
    const { pc } = await buildLab();

    const perms = await pc.executeCommand(`ls -l ${SCRIPT_PATH}`);
    expect(perms).toMatch(/^-rwx/);

    const status = await pc.executeCommand('systemctl status net-monitor');
    expect(status).toContain('Loaded: loaded (/etc/systemd/system/net-monitor.service');
    expect(status).toContain('Active: inactive (dead)');

    await pc.executeCommand('systemctl enable net-monitor');
    expect(vfsOf(pc).exists(WANTS_LINK)).toBe(true);
  }, 30000);

  it('phase nominale : active (running), métriques, log applicatif et journald cohérents', async () => {
    const { pc } = await buildLab();
    await pc.executeCommand('systemctl start net-monitor');
    await sleep(2500);

    const status = await pc.executeCommand('systemctl status net-monitor');
    expect(status).toContain('Active: active (running)');
    expect(status).toContain('Main PID:');
    expect(status).toContain('Tasks:');
    expect(status).toContain('Memory:');
    expect(status).toContain('CPU:');
    expect(status).toContain('CGroup:');

    const log = readLog(pc);
    expect(log).toContain('Service net-monitor démarré');
    const okLines = log.split('\n').filter((l) => l.includes(`OK ${SWITCH_IP}`));
    expect(okLines.length).toBeGreaterThanOrEqual(2);
    expect(okLines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} OK/);

    const journal = await pc.executeCommand('journalctl -u net-monitor.service');
    expect(journal).toContain('Service net-monitor démarré');
    expect(journal).toContain(`OK ${SWITCH_IP} joignable`);

    await pc.executeCommand('systemctl stop net-monitor');
  }, 30000);

  it('phase panne réseau : ALERTE à la déconnexion, retour OK à la reconnexion sans intervention', async () => {
    const { pc, sw, cable } = await buildLab();
    await pc.executeCommand('systemctl start net-monitor');
    await sleep(1800);
    expect(readLog(pc)).toContain(`OK ${SWITCH_IP}`);

    cable.disconnect();
    await sleep(3500);

    const logDuringOutage = readLog(pc);
    expect(logDuringOutage).toContain(`ALERTE ${SWITCH_IP} injoignable`);
    const journal = await pc.executeCommand('journalctl -u net-monitor.service');
    expect(journal).toContain(`ALERTE ${SWITCH_IP} injoignable`);

    const alertCount = logDuringOutage.split('\n').filter((l) => l.includes('ALERTE')).length;
    cable.connect(pc.getPort('eth0')!, sw.getPorts()[0]);
    await sleep(2500);

    const logAfter = readLog(pc).split('\n');
    const lastLine = logAfter.filter((l) => l.trim().length > 0).pop()!;
    expect(lastLine).toContain('OK');
    expect(readLog(pc).split('\n').filter((l) => l.includes('ALERTE')).length).toBe(alertCount);

    await pc.executeCommand('systemctl stop net-monitor');
  }, 30000);

  it('phase kill forcé : signature killed, redémarrage auto avec nouveau PID, reprise du log', async () => {
    const { pc } = await buildLab();
    await pc.executeCommand('systemctl start net-monitor');
    await sleep(1500);

    const shown = await pc.executeCommand('systemctl show -p MainPID net-monitor');
    const oldPid = Number(/MainPID=(\d+)/.exec(shown)?.[1]);
    expect(oldPid).toBeGreaterThan(1);

    await pc.executeCommand(`kill -9 ${oldPid}`);

    const transient = await pc.executeCommand('systemctl status net-monitor');
    expect(transient).toContain('code=killed, signal=KILL');

    await sleep(1500);
    const after = await pc.executeCommand('systemctl show -p MainPID net-monitor');
    const newPid = Number(/MainPID=(\d+)/.exec(after)?.[1]);
    expect(newPid).toBeGreaterThan(1);
    expect(newPid).not.toBe(oldPid);
    expect(await pc.executeCommand('systemctl is-active net-monitor')).toContain('active');

    const startedLines = readLog(pc).split('\n')
      .filter((l) => l.includes('Service net-monitor démarré'));
    expect(startedLines.length).toBeGreaterThanOrEqual(2);

    await pc.executeCommand('systemctl stop net-monitor');
  }, 30000);

  it('un arrêt propre via systemctl stop ne déclenche PAS le Restart=on-failure', async () => {
    const { pc } = await buildLab();
    await pc.executeCommand('systemctl start net-monitor');
    await sleep(1200);

    await pc.executeCommand('systemctl stop net-monitor');
    await sleep(1000);

    expect((await pc.executeCommand('systemctl is-active net-monitor')).trim()).toBe('inactive');
    const log = readLog(pc);
    const startedLines = log.split('\n').filter((l) => l.includes('Service net-monitor démarré'));
    expect(startedLines).toHaveLength(1);
  }, 30000);

  it('phase persistance : le service enabled survit à un reboot et reprend la surveillance', async () => {
    const { pc } = await buildLab();
    await pc.executeCommand('systemctl enable net-monitor');
    await pc.executeCommand('systemctl start net-monitor');
    await sleep(1200);
    const logSizeBefore = readLog(pc).length;

    await pc.executeCommand('reboot');
    await sleep(2000);

    expect((await pc.executeCommand('systemctl is-active net-monitor')).trim()).toBe('active');
    const log = readLog(pc);
    expect(log.length).toBeGreaterThan(logSizeBefore);
    const startedLines = log.split('\n').filter((l) => l.includes('Service net-monitor démarré'));
    expect(startedLines.length).toBeGreaterThanOrEqual(2);

    await pc.executeCommand('systemctl stop net-monitor');
  }, 30000);
});
