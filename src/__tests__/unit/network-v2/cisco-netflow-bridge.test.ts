import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function run(r: CiscoRouter, cmds: string[]): Promise<void> {
  for (const c of cmds) await r.executeCommand(c);
}

describe('NetflowService → NetFlowAgent bridge (GAP §6.2)', () => {
  it('Flexible NetFlow: exporter + monitor + interface attach pushes the collector and enables the agent', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 2);
    await run(r, [
      'enable', 'configure terminal',
      'flow exporter EXP1',
      'destination 10.0.0.99',
      'transport udp 9996',
      'export-protocol netflow-v9',
      'exit',
      'flow record REC1',
      'match ipv4 source address',
      'collect counter bytes',
      'exit',
      'flow monitor MON1',
      'record REC1',
      'exporter EXP1',
      'cache timeout active 120',
      'cache timeout inactive 30',
      'exit',
      'interface GigabitEthernet0/0',
      'ip flow monitor MON1 input',
      'end',
    ]);

    const agent = r.getNetFlowAgent();
    const cfg = agent.getConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.activeTimeoutSec).toBe(120);
    expect(cfg.inactiveTimeoutSec).toBe(30);

    const collectors = agent.listCollectors();
    expect(collectors).toHaveLength(1);
    expect(collectors[0].ip).toBe('10.0.0.99');
    expect(collectors[0].port).toBe(9996);
  });

  it('Legacy NetFlow: ip flow-export destination + interface ip flow ingress activates the agent', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 2);
    await run(r, [
      'enable', 'configure terminal',
      'ip flow-export destination 192.168.1.50 2055',
      'ip flow-export version 5',
      'ip flow-cache timeout active 5',
      'ip flow-cache timeout inactive 15',
      'interface GigabitEthernet0/0',
      'ip flow ingress',
      'end',
    ]);

    const agent = r.getNetFlowAgent();
    expect(agent.getConfig().enabled).toBe(true);
    expect(agent.getConfig().activeTimeoutSec).toBe(300);
    expect(agent.getConfig().inactiveTimeoutSec).toBe(15);
    const collectors = agent.listCollectors();
    expect(collectors).toHaveLength(1);
    expect(collectors[0].ip).toBe('192.168.1.50');
    expect(collectors[0].port).toBe(2055);
  });

  it('Configuring an exporter without an interface attachment does NOT activate the agent', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 2);
    await run(r, [
      'enable', 'configure terminal',
      'flow exporter EXP1',
      'destination 10.0.0.99',
      'exit',
      'flow monitor MON1',
      'exporter EXP1',
      'end',
    ]);
    const agent = r.getNetFlowAgent();
    expect(agent.listCollectors()).toEqual([]);
    expect(agent.getConfig().enabled).toBe(false);
  });

  it('Re-binding an exporter to a different destination updates the agent collectors', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 2);
    await run(r, [
      'enable', 'configure terminal',
      'flow exporter EXP1', 'destination 10.0.0.99', 'exit',
      'flow monitor MON1', 'exporter EXP1', 'exit',
      'interface GigabitEthernet0/0', 'ip flow monitor MON1 input', 'exit',
    ]);
    const before = r.getNetFlowAgent().listCollectors().map((c) => c.ip);
    expect(before).toEqual(['10.0.0.99']);

    await run(r, ['flow exporter EXP1', 'destination 10.0.0.100', 'end']);
    const after = r.getNetFlowAgent().listCollectors().map((c) => c.ip);
    expect(after).toEqual(['10.0.0.100']);
  });
});
