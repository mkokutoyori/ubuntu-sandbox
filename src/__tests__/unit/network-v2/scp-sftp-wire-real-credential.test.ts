/**
 * scp/sftp shell commands — real-wire transfer when a real credential
 * is offered (audit 03, MAJEUR §4 / Top-10 #3).
 *
 * Before this, `scp`/`sftp` always resolved the remote endpoint straight
 * to the target device's own ISftpFileSystem object (VfsSftpFileSystem
 * wrapping the remote's VirtualFileSystem directly) — a VFS-to-VFS copy,
 * never a byte over TcpSocket.send()/Port/Cable, even though the native
 * SFTP channel (SshChannelManager.openSftp()) already speaks the real
 * SSH_FXP_* wire protocol for interactive `sftp` sessions.
 *
 * `sshpass -p <pw> scp|sftp ...` is the one place scp/sftp can offer a
 * REAL password (bare scp/sftp has no such mechanism and — per
 * `password-policy-ssh-scp-sftp-coherence.test.ts` — relies on
 * `verifyOfferedPassword`'s intentional "trust when nothing was
 * offered" convenience, which has no real credential to authenticate
 * with over the wire). When a real password IS offered, this test
 * proves the transfer now goes through a genuine authenticated
 * SshSession + SshSftpChannel (WireSftpFileSystem) — spying on
 * SshSftpChannel.prototype.sendRequest, the one method every real
 * SSH_FXP_* wire op funnels through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { SshSftpChannel } from '@/network/protocols/ssh/channels/SshSftpChannel';
import { buildLan, assignIps, type SshLan, PC2_IP } from './ssh-lan-fixtures';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

describe('scp/sftp go over the real wire when sshpass offers a real password', () => {
  let lan: SshLan;

  beforeEach(async () => {
    lan = buildLan();
    await assignIps(lan);
  });

  it('sshpass -p <pw> scp: the transfer calls SshSftpChannel.sendRequest (real SSH_FXP_* wire ops), not a direct VFS copy', async () => {
    const spy = vi.spyOn(SshSftpChannel.prototype, 'sendRequest');
    await lan.pc1.executeCommand("echo 'hello real wire' > /home/user/payload.txt");

    const out = await lan.pc1.executeCommand(
      `sshpass -p admin scp /home/user/payload.txt user@${PC2_IP}:/home/user/payload.txt`,
    );

    // Real wire ops: OPEN (via 'put'), WRITE, CLOSE all funnel through
    // sendRequest() on the client-side SshSftpChannel.
    const putCalls = spy.mock.calls.filter(([req]) => (req as { op: string }).op === 'put');
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    expect((putCalls[0][0] as { content: string }).content).toContain('hello real wire');
    expect(out).not.toMatch(/no route to host/);

    const remoteContent = await lan.pc2.executeCommand('cat /home/user/payload.txt');
    expect(remoteContent.trim()).toBe('hello real wire');

    spy.mockRestore();
  });

  it('sshpass -p <pw> sftp -b <batchfile>: batch commands also go through the real wire channel', async () => {
    const spy = vi.spyOn(SshSftpChannel.prototype, 'sendRequest');
    await lan.pc2.executeCommand("echo 'remote file' > /home/user/remote.txt");
    await lan.pc1.executeCommand(
      "printf 'get /home/user/remote.txt /home/user/fetched.txt\\nbye\\n' > /home/user/batch.sftp",
    );

    const out = await lan.pc1.executeCommand(
      `sshpass -p admin sftp -b /home/user/batch.sftp user@${PC2_IP}`,
    );

    const getCalls = spy.mock.calls.filter(([req]) => (req as { op: string }).op === 'get');
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
    expect(out).toMatch(/Connected to/);

    const localContent = await lan.pc1.executeCommand('cat /home/user/fetched.txt');
    expect(localContent.trim()).toBe('remote file');

    spy.mockRestore();
  });

  it('wrong sshpass password is rejected before any transfer (probe unchanged)', async () => {
    const spy = vi.spyOn(SshSftpChannel.prototype, 'sendRequest');
    await lan.pc1.executeCommand("echo 'should not land' > /home/user/payload2.txt");

    const out = await lan.pc1.executeCommand(
      `sshpass -p totally-wrong scp /home/user/payload2.txt user@${PC2_IP}:/home/user/should-not-land.txt`,
    );

    expect(out).toMatch(/Permission denied/i);
    expect(spy).not.toHaveBeenCalled();
    const exists = await lan.pc2.executeCommand('test -f /home/user/should-not-land.txt && echo yes || echo no');
    expect(exists.trim()).toBe('no');

    spy.mockRestore();
  });

  it('plain scp (no sshpass) is unaffected — still the pre-existing behavior', async () => {
    const spy = vi.spyOn(SshSftpChannel.prototype, 'sendRequest');
    await lan.pc1.executeCommand("echo 'plain path' > /home/user/plain.txt");

    const out = await lan.pc1.executeCommand(
      `scp /home/user/plain.txt user@${PC2_IP}:/home/user/plain.txt`,
    );

    expect(out).not.toMatch(/no route to host/);
    expect(spy).not.toHaveBeenCalled();
    const remoteContent = await lan.pc2.executeCommand('cat /home/user/plain.txt');
    expect(remoteContent.trim()).toBe('plain path');

    spy.mockRestore();
  });
});
