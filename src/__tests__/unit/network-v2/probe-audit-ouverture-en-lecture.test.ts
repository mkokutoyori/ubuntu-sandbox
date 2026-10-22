/**
 * Un open() en lecture est enregistre avec ses vrais drapeaux : O_RDONLY (a2=0) pour une lecture, O_WRONLY|O_CREAT|
 * O_TRUNC (0x241) pour une ecriture. Avant, tout openat portait 0x241, y compris le `cat /etc/hostname` d'un
 * auditeur : l'enregistrement affirmait une ecriture qui n'avait pas eu lieu, et une regle `-F a2=0` ne
 * correspondait a aucune lecture. Source : le noyau Linux (include/uapi/asm-generic/fcntl.h : O_WRONLY 01,
 * O_CREAT 0100, O_TRUNC 01000) ; auditd lui-meme n'est pas en cause.
 *
 * Mesure avant : les 3 cas de lecture tombent ; le temoin (une ecriture garde 0x241) passe dans les deux etats et
 * borne la correction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

async function rootHost(): Promise<LinuxPC> {
  const pc = new LinuxPC('AuditHost', 0, 0);
  await pc.executeCommand('sudo su -');
  return pc;
}

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('open flags in SYSCALL records', () => {
  it('witness: a write keeps O_WRONLY|O_CREAT|O_TRUNC', async () => {
    const pc = await rootHost();
    await pc.executeCommand('auditctl -w /tmp/out.txt -p w -k wr');
    await pc.executeCommand('echo x > /tmp/out.txt');
    expect(await pc.executeCommand('ausearch -k wr -r | grep -o "a1=[0-9a-f]*" | head -1')).toBe('a1=241');
  });

  it('a read records O_RDONLY', async () => {
    const pc = await rootHost();
    await pc.executeCommand('auditctl -w /etc/hostname -p r -k rd');
    await pc.executeCommand('cat /etc/hostname');
    expect(await pc.executeCommand('ausearch -k rd -r | grep -o "a2=[0-9a-f]*" | head -1')).toBe('a2=0');
    expect(await pc.executeCommand('ausearch -k rd -i | grep -o "a2=[A-Z_|]*" | head -1')).toBe('a2=O_RDONLY');
  });

  it('a rule on a2=0 matches the read, and not the write', async () => {
    const pc = await rootHost();
    await pc.executeCommand('auditctl -a always,exit -F arch=b64 -S openat -F a2=0 -F path=/etc/hostname -k only-reads');
    await pc.executeCommand('cat /etc/hostname');
    expect((await pc.executeCommand('ausearch -k only-reads -r | grep -c "type=SYSCALL"')).trim()).toBe('1');
  });

  it('autrace shows the program opening its file for reading', async () => {
    const pc = await rootHost();
    const out = await pc.executeCommand('autrace /usr/bin/cat /etc/hostname');
    const pid = /-p (\d+)'/.exec(out)?.[1];
    expect(await pc.executeCommand(`ausearch -i -p ${pid} | grep "syscall=openat"`)).toContain('a2=O_RDONLY');
  });
});
