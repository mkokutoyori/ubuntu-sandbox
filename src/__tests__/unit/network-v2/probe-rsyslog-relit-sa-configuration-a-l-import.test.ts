/*
 * A saved lab keeps a collector's rsyslog configuration AND the reopened machine listens accordingly.
 *
 * Measured on the Meridian lab (SIEM in `module(load="imudp")` + `input(type="imudp" port="514")`, rsyslog restarted, FGT-HQ sending its
 * log records to it), exported and imported into a fresh session: `/etc/rsyslog.conf` was restored byte for byte and `systemctl is-active
 * rsyslog` said `active`, yet nothing listened on UDP 514 and the collector stayed empty. rsyslog starts at boot on the factory file, the
 * saved one is written back afterwards, and nothing told the daemon to read it again (chrony already had that step,
 * `restartTimeDaemonFromFiles`; rsyslog did not).
 *
 * A restored machine now restarts a running rsyslog from the files it was given, as a booted machine would have read them.
 *
 * Discriminated with git stash of src/network and src/store, the probe kept: 2 of the 3 cases fall. The WITNESS passes either way: it is
 * built in the same lab before the export, so a failure after the import accuses the import and not the setup.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildConnection, type Connection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';

beforeEach(() => {
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const LISTEN_UDP = [
  'sudo sed -i \'s/^#module(load="imudp")/module(load="imudp")/\' /etc/rsyslog.conf',
  'sudo sed -i \'s/^#input(type="imudp" port="514")/input(type="imudp" port="514")/\' /etc/rsyslog.conf',
  'sudo systemctl restart rsyslog',
];

async function build() {
  const collector = new LinuxServer('linux-server', 'SIEM');
  const sender = new LinuxServer('linux-server', 'SENDER');
  const connections = [buildConnection(collector, 'eth0', sender, 'eth0', 'ethernet')]
    .filter((c): c is Connection => c !== null);
  await collector.executeCommand('sudo ip addr add 192.168.50.5/24 dev eth0');
  await sender.executeCommand('sudo ip addr add 192.168.50.9/24 dev eth0');
  for (const line of LISTEN_UDP) await collector.executeCommand(line);
  const devices = new Map<string, Equipment>([collector, sender].map((d) => [d.getId(), d as Equipment]));
  return { collector, sender, devices, connections };
}

async function reopened(lab: Awaited<ReturnType<typeof build>>) {
  const saved = JSON.parse(JSON.stringify(exportTopology('lab', lab.devices, lab.connections)));
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  const imported = await importTopology(saved);
  const byName = new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d]));
  return { collector: byName.get('SIEM') as LinuxServer, sender: byName.get('SENDER') as LinuxServer };
}

describe('rsyslog survives a save and a reopening', () => {
  it('WITNESS: the collector listens on UDP 514 and stores a message before it is saved', async () => {
    const lab = await build();
    expect(await lab.collector.executeCommand('ss -lun')).toMatch(/0\.0\.0\.0:514/);
    await lab.sender.executeCommand('logger -n 192.168.50.5 -P 514 -d before-export');
    expect(await lab.collector.executeCommand('cat /var/log/syslog')).toContain('before-export');
  });

  it('a reopened collector listens on UDP 514', async () => {
    const { collector } = await reopened(await build());
    expect(await collector.executeCommand('ss -lun')).toMatch(/0\.0\.0\.0:514/);
  });

  it('a reopened collector stores what a sender logs to it', async () => {
    const { collector, sender } = await reopened(await build());
    await sender.executeCommand('sudo ip link set eth0 up');
    await sender.executeCommand('logger -n 192.168.50.5 -P 514 -d after-reopen');
    expect(await collector.executeCommand('cat /var/log/syslog')).toContain('after-reopen');
  });
});
