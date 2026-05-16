/**
 * User/Group cmdlets migrated to PSInterpreter (Phase 2 batch 3).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function setup() {
  const pc = new WindowsPC('windows-pc', 'WIN-USR');
  pc.setCurrentUser('Administrator');
  return new PSInterpreter(createWindowsPSProviders(pc));
}

describe('User cmdlets migrated', () => {
  it('Get-LocalUser lists Administrator', () => {
    const out = setup().executeInteractive('Get-LocalUser');
    expect(out.toLowerCase()).toContain('administrator');
  });

  it('New-LocalUser then Get-LocalUser shows the new user', () => {
    const i = setup();
    i.executeInteractive('New-LocalUser -Name TestUser -Password "Pass1234!" -Description "automated"');
    const out = i.executeInteractive('Get-LocalUser TestUser');
    expect(out).toContain('TestUser');
  });

  it('Disable-LocalUser flips Enabled to False', () => {
    const i = setup();
    i.executeInteractive('New-LocalUser -Name DisableMe -Password "Pass1234!"');
    i.executeInteractive('Disable-LocalUser DisableMe');
    const out = i.executeInteractive('Get-LocalUser DisableMe');
    expect(out).toMatch(/false/i);
  });

  it('Remove-LocalUser deletes the user', () => {
    const i = setup();
    i.executeInteractive('New-LocalUser -Name DeleteMe -Password "Pass1234!"');
    i.executeInteractive('Remove-LocalUser DeleteMe');
    const out = i.executeInteractive('Get-LocalUser DeleteMe');
    expect(out.toLowerCase()).toContain('not found');
  });
});

describe('Group cmdlets migrated', () => {
  it('Get-LocalGroup lists built-in Administrators', () => {
    const out = setup().executeInteractive('Get-LocalGroup');
    expect(out).toContain('Administrators');
  });

  it('New-LocalGroup + Add-LocalGroupMember + Get-LocalGroupMember', () => {
    const i = setup();
    i.executeInteractive('New-LocalUser -Name g_user -Password "Pass1234!"');
    i.executeInteractive('New-LocalGroup -Name TestGroup -Description "qa"');
    i.executeInteractive('Add-LocalGroupMember -Group TestGroup -Member g_user');
    const out = i.executeInteractive('Get-LocalGroupMember -Group TestGroup');
    expect(out).toContain('g_user');
  });

  it('Remove-LocalGroupMember then list members no longer contains the user', () => {
    const i = setup();
    i.executeInteractive('New-LocalUser -Name r_user -Password "Pass1234!"');
    i.executeInteractive('New-LocalGroup -Name RemGroup');
    i.executeInteractive('Add-LocalGroupMember -Group RemGroup -Member r_user');
    i.executeInteractive('Remove-LocalGroupMember -Group RemGroup -Member r_user');
    const out = i.executeInteractive('Get-LocalGroupMember -Group RemGroup');
    expect(out).not.toContain('r_user');
  });
});
