/**
 * SSH LAN — UI/UX semantics that distinguish a true "subshell" SSH
 * experience from a wholesale terminal swap.
 *
 * Scope:
 *  - The terminal modal's *header* (rendered by `InfoBar` from
 *    `getInfoBarContent()`) always identifies the **local** machine
 *    the user opened the terminal on, even after `ssh` push.
 *  - The in-line bash prompt rendered for each command line keeps
 *    showing the **remote** machine, because that is what the user
 *    types commands against.
 *  - The new `getLocalDevice()` accessor returns the local-side
 *    device for any UI / wiring code that needs it.
 *
 * Reference: user feedback on the SSH experience — the modal title
 *            should not look like a wholesale teleport to the
 *            remote host.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { Equipment } from '@/network';
import {
  buildLan,
  assignIps,
  type SshLan,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';

describe('SSH LAN — subshell-style header semantics', () => {
  let lan: SshLan;
  let term: LinuxTerminalSession;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
    term = new LinuxTerminalSession('term-1', lan.pc1);
  });

  // H1
  it('H1 — getInfoBarContent reflects the local hostname before any SSH push', () => {
    const info = term.getInfoBarContent();
    expect(info.left).toContain(lan.pc1.getHostname());
  });

  // H2
  it('H2 — after pushRemoteDevice, getInfoBarContent still shows the LOCAL hostname', () => {
    const localHost = lan.pc1.getHostname();
    const remoteHost = lan.pc2.getHostname();
    term.pushRemoteDevice(lan.pc2, 'user', PC2_IP, () => undefined);
    const info = term.getInfoBarContent();
    expect(info.left).toContain(localHost);
    expect(info.left).not.toContain(remoteHost);
  });

  // H3
  it('H3 — after two nested SSH pushes, header still names the local host', () => {
    const localHost = lan.pc1.getHostname();
    term.pushRemoteDevice(lan.pc2, 'user', PC2_IP, () => undefined);
    term.pushRemoteDevice(lan.pc3, 'alice', PC3_IP, () => undefined);
    expect(term.getInfoBarContent().left).toContain(localHost);
  });

  // H4
  it('H4 — getPromptParts reflects the REMOTE host while in SSH (in-line prompt)', () => {
    const remoteHost = lan.pc2.getHostname();
    term.pushRemoteDevice(lan.pc2, 'user', PC2_IP, () => undefined);
    const p = term.getPromptParts();
    expect(p.hostname).toBe(remoteHost);
    expect(p.user).toBe('user');
  });

  // H5
  it('H5 — getLocalDevice() returns the pre-SSH device even after a push', () => {
    expect(term.getLocalDevice()).toBe(lan.pc1);
    term.pushRemoteDevice(lan.pc2, 'user', PC2_IP, () => undefined);
    expect(term.getLocalDevice()).toBe(lan.pc1);
    term.pushRemoteDevice(lan.pc3, 'alice', PC3_IP, () => undefined);
    expect(term.getLocalDevice()).toBe(lan.pc1);
  });

  // H6
  it('H6 — popping all SSH frames returns the header to the local hostname', () => {
    const localHost = lan.pc1.getHostname();
    term.pushRemoteDevice(lan.pc2, 'user', PC2_IP, () => undefined);
    term.popRemoteDevice();
    expect(term.getInfoBarContent().left).toContain(localHost);
    expect(term.getLocalDevice()).toBe(lan.pc1);
  });

  // H7
  it('H7 — banner from getSshContextInfo continues to advertise the remote chain', () => {
    term.pushRemoteDevice(lan.pc2, 'user', PC2_IP, () => undefined);
    const ctx = term.getSshContextInfo();
    expect(ctx.active).toBe(true);
    expect(ctx.current).toBe(PC2_IP);
    // The banner is the user's signal that they ARE on the remote — only
    // the modal header stays local.
    expect(ctx.chain[0]).toEqual({ host: PC2_IP, user: 'user' });
  });
});
