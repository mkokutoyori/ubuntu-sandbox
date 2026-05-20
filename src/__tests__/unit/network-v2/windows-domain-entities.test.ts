/**
 * Unit tests — Windows process / service classes inheriting from the
 * OS core. These are the cross-OS hierarchy entry points for Phase F
 * (Windows feature gating) — they need to satisfy the original flat
 * record interface AND expose the richer OSProcess / OSService surface.
 */

import { describe, it, expect } from 'vitest';
import { WindowsProcess } from '@/network/devices/windows/process/WindowsProcess';
import { WindowsService } from '@/network/devices/windows/service/WindowsService';

describe('WindowsProcess entity', () => {
  const base = {
    pid: 620, name: 'svchost.exe', ppid: 368,
    session: 'Services' as const, sessionId: 0, owner: 'NT AUTHORITY\\LocalService',
    handles: 320, npmK: 16, pmK: 9000, wsK: 12000, cpuSec: 1.5,
    status: 'Running' as const, windowTitle: '',
    critical: false, systemOwned: true,
    hostedServices: ['Dhcp', 'Dnscache'],
  };

  it('preserves the flat WindowsProcess shape on the instance', () => {
    const p = new WindowsProcess(base);
    expect(p.pid).toBe(620);
    expect(p.name).toBe('svchost.exe');
    expect(p.hostedServices).toEqual(['Dhcp', 'Dnscache']);
    expect(p.systemOwned).toBe(true);
  });

  it('inherits OSProcess surface (rlimits, namespaces, openFiles)', () => {
    const p = new WindowsProcess(base);
    expect(p.rlimits).toBeDefined();
    expect(p.namespaces).toBeDefined();
    expect(p.openFiles).toEqual([]);
  });

  it('hostsService / hostService / unhostService update the table', () => {
    const p = new WindowsProcess(base);
    expect(p.hostsService('Dhcp')).toBe(true);
    expect(p.hostsService('Spooler')).toBe(false);
    p.hostService('Spooler');
    expect(p.hostsService('Spooler')).toBe(true);
    p.unhostService('Dhcp');
    expect(p.hostsService('Dhcp')).toBe(false);
  });

  it('isCritical / isSystemOwned / isResponding reflect state', () => {
    const p = new WindowsProcess({ ...base, critical: true, status: 'Not Responding' });
    expect(p.isCritical()).toBe(true);
    expect(p.isSystemOwned()).toBe(true);
    expect(p.isResponding()).toBe(false);
  });

  it('snapshot round-trips to the flat record', () => {
    const snap = new WindowsProcess(base).snapshot();
    expect(snap).toMatchObject(base);
  });
});

describe('WindowsService entity', () => {
  const base = {
    name: 'Dhcp', displayName: 'DHCP Client',
    description: 'Registers and updates IP addresses…',
    state: 'Running' as const,
    startType: 'Automatic' as const,
    serviceType: 'WIN32_SHARE_PROCESS' as const,
    binaryPath: 'C:\\Windows\\System32\\svchost.exe -k LocalServiceNetworkRestricted',
    account: 'NT AUTHORITY\\LocalService',
    dependencies: ['Afd', 'NSI', 'Tdx'],
    canPauseAndContinue: false,
    acceptsShutdown: true,
    processName: 'svchost.exe',
    builtIn: true,
  };

  it('keeps the flat WindowsService shape on the instance', () => {
    const s = new WindowsService(base);
    expect(s.name).toBe('Dhcp');
    expect(s.binaryPath).toContain('svchost.exe');
    expect(s.dependencies).toEqual(['Afd', 'NSI', 'Tdx']);
  });

  it('inherits OSService surface (recoveryActions, conditionPathExists, …)', () => {
    const s = new WindowsService(base);
    expect(s.recoveryActions).toBeDefined();
    expect(s.conditionPathExists).toEqual([]);
  });

  it('translates Windows state to the OS state', () => {
    const running = new WindowsService(base);
    expect(running.isActive()).toBe(true);
    const stopped = new WindowsService({ ...base, state: 'Stopped' });
    expect(stopped.isActive()).toBe(false);
    expect(stopped.isInactive()).toBe(true);
  });

  it('isRunning / isStopped / isPaused / isPending behave as expected', () => {
    expect(new WindowsService(base).isRunning()).toBe(true);
    expect(new WindowsService({ ...base, state: 'Stopped' }).isStopped()).toBe(true);
    expect(new WindowsService({ ...base, state: 'Paused' }).isPaused()).toBe(true);
    expect(new WindowsService({ ...base, state: 'StartPending' }).isPending()).toBe(true);
  });

  it('canBeStopped is false for critical services', () => {
    expect(new WindowsService({ ...base, critical: true }).canBeStopped()).toBe(false);
    expect(new WindowsService(base).canBeStopped()).toBe(true);
  });

  it('transitionTo / changeStartType keep both layers in sync', () => {
    const s = new WindowsService(base);
    s.transitionTo('Stopped');
    expect(s.state).toBe('Stopped');
    expect(s.isActive()).toBe(false);
    s.changeStartType('Disabled');
    expect(s.startType).toBe('Disabled');
    expect(s.canStart()).toBe(false);
  });

  it('snapshot round-trips to the flat record', () => {
    expect(new WindowsService(base).snapshot()).toMatchObject(base);
  });
});
