/**
 * Measured against the real useradd/userdel/groupadd/groupdel of shadow 4.13 with libaudit replaced by
 * scripts/oracle/audit_shim.c (scripts/oracle/record_shadow_audit.py): the type, operation text and acct/id form of every
 * message.  Both tests fall before the fix (the simulator wrote one record per command with invented operations such as
 * "add-user" and a duplicated acct= outside msg='...').  Grantors of PAM:chauthtok are not compared: they depend on the PAM
 * stack of the host.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { nameToMessageType } from '@/network/devices/linux/audit/tools/AuditEventAssembler';

interface Row { type: number; op: string; name: string; id: number; res: number }
const real = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/shadow-audit-messages.json', 'utf8')) as Record<string, Row[]>;

type Shape = { type: number; op: string; form: 'acct' | 'id' };

const realShape = (rows: Row[]): Shape[] => rows.map((r) => ({ type: r.type, op: r.op, form: r.id === -1 ? 'acct' : 'id' }));

function simShape(log: string, from: number): Shape[] {
  const lines = log.split('\n').filter((l) => l.startsWith('type=')).slice(from);
  return lines.map((line) => {
    const type = nameToMessageType(/^type=(\S+)/.exec(line)![1]);
    const msg = /msg='([^']*)'/.exec(line)![1];
    const opMatch = /^op=(.*?) (?:acct=|id=)/.exec(msg)!;
    return { type, op: opMatch[1], form: / acct=/.test(msg) ? 'acct' : 'id' };
  });
}

async function steps(srv: LinuxServer, commands: string[]): Promise<Shape[][]> {
  const out: Shape[][] = [];
  for (const command of commands) {
    const before = (await srv.executeCommand('cat /var/log/audit/audit.log')).split('\n').filter((l) => l.startsWith('type=')).length;
    await srv.executeCommand(command);
    out.push(simShape(await srv.executeCommand('cat /var/log/audit/audit.log'), before));
  }
  return out;
}

describe('audit messages of the shadow tools against the real binaries', () => {
  it('useradd -m, userdel -r, groupadd, groupdel, useradd -G emit the same operations as the real tools', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const [add, delHome, gadd, gdel, addG, delG] = await steps(srv, [
      'useradd -m zzuser', 'userdel -r zzuser', 'groupadd zzgrp', 'groupdel zzgrp',
      'useradd -m -G sudo zzuser', 'userdel -r zzuser',
    ]);
    expect(add).toEqual(realShape(real['useradd -m']));
    expect(delHome).toEqual(realShape(real['userdel -r']));
    expect(gadd).toEqual(realShape(real.groupadd));
    expect(gdel).toEqual(realShape(real.groupdel));
    expect(addG).toEqual(realShape(real['useradd -m -G']));
    expect(delG).toEqual(realShape(real['userdel -r (member of a group)']));
  });

  it('useradd -M and userdel without -r omit the home directory records', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const [add, del] = await steps(srv, ['useradd -M zzuser', 'userdel zzuser']);
    expect(add).toEqual(realShape(real['useradd (no home)']));
    expect(del).toEqual(realShape(real.userdel));
  });
});
