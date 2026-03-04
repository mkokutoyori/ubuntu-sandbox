/**
 * Linux History Command — TDD Test Suite
 *
 * Tests cover:
 *   Group 1: Basic history tracking and display
 *   Group 2: History options (-c, -d, -w, -r)
 *   Group 3: Edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// Group 1: Basic History Tracking and Display
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Basic History Tracking and Display', () => {

  it('should display empty history when no commands have been run', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const output = await pc.executeCommand('history');
    // history itself should appear as entry 1
    expect(output).toContain('1');
    expect(output).toContain('history');
  });

  it('should track executed commands', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo hello');
    await pc.executeCommand('pwd');
    const output = await pc.executeCommand('history');

    expect(output).toContain('echo hello');
    expect(output).toContain('pwd');
    expect(output).toContain('history');
  });

  it('should number history entries starting from 1', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo first');
    await pc.executeCommand('echo second');
    const output = await pc.executeCommand('history');
    const lines = output.trim().split('\n');

    // Should have 3 entries: echo first, echo second, history
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatch(/\s*1\s+echo first$/);
    expect(lines[1]).toMatch(/\s*2\s+echo second$/);
    expect(lines[2]).toMatch(/\s*3\s+history$/);
  });

  it('should show last N entries with history N', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo a');
    await pc.executeCommand('echo b');
    await pc.executeCommand('echo c');
    await pc.executeCommand('echo d');
    const output = await pc.executeCommand('history 2');

    const lines = output.trim().split('\n');
    // Should show last 2 entries: echo d and history 2
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('echo d');
    expect(lines[1]).toContain('history 2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: History Options
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: History Options', () => {

  it('should clear history with history -c', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo hello');
    await pc.executeCommand('echo world');
    await pc.executeCommand('history -c');

    const output = await pc.executeCommand('history');
    const lines = output.trim().split('\n');
    // After -c, only the 'history' command itself should be in history
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('history');
  });

  it('should delete specific entry with history -d N', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo first');
    await pc.executeCommand('echo second');
    await pc.executeCommand('echo third');
    await pc.executeCommand('history -d 2');

    const output = await pc.executeCommand('history');
    expect(output).toContain('echo first');
    expect(output).not.toContain('echo second');
    expect(output).toContain('echo third');
  });

  it('should write history to ~/.bash_history with history -w', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo hello');
    await pc.executeCommand('history -w');

    // LinuxPC default user is 'user' with home /home/user
    const content = await pc.executeCommand('cat /home/user/.bash_history');
    expect(content).toContain('echo hello');
  });

  it('should read history from ~/.bash_history with history -r', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    // First, build some history and write it
    await pc.executeCommand('echo savedcmd');
    await pc.executeCommand('history -w');
    // Clear and re-read
    await pc.executeCommand('history -c');
    await pc.executeCommand('history -r');

    const output = await pc.executeCommand('history');
    expect(output).toContain('echo savedcmd');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: Edge Cases
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Edge Cases', () => {

  it('should handle history -d with invalid offset', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo test');
    const output = await pc.executeCommand('history -d 999');
    expect(output).toContain('history position out of range');
  });

  it('should handle history with N larger than actual entries', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo one');
    const output = await pc.executeCommand('history 100');
    const lines = output.trim().split('\n');
    // Should show all entries (2: echo one + history 100)
    expect(lines.length).toBe(2);
  });

  it('should include piped commands in history', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo hello | grep hello');
    const output = await pc.executeCommand('history');
    expect(output).toContain('echo hello | grep hello');
  });

  it('should include chained commands in history', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo a && echo b');
    const output = await pc.executeCommand('history');
    expect(output).toContain('echo a && echo b');
  });
});
