import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import {
  deliverLocalMessage, resolveAliasRecipients, mailboxPathFor,
  type MailDropFileSystem,
} from '@/network/smtp/localDelivery';

let bus: EventBus;
let pc: LinuxPC;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);
  pc = new LinuxPC('pc1');
  pc.setEventBus(bus);
});

const ALIASES = [
  '# /etc/aliases',
  'postmaster: root',
  'webmaster: alice, bob',
  'staff: webmaster, carol',
  'root: root',
  'loopa: loopb',
  'loopb: loopa',
].join('\\n');

async function writeAliases(host: LinuxPC | LinuxServer, body = ALIASES): Promise<void> {
  await host.executeCommand(`sudo sh -c 'printf "${body}\\n" > /etc/aliases'`);
}

async function getent(host: LinuxPC | LinuxServer, args: string): Promise<{ output: string; exitCode: number }> {
  const out = await host.executeCommand(`getent ${args}; echo "__rc=$?"`);
  const m = /__rc=(\d+)\s*$/.exec(out);
  return {
    output: out.replace(/__rc=\d+\s*$/, '').trim(),
    exitCode: m ? parseInt(m[1], 10) : 0,
  };
}

describe('getent aliases (P1)', () => {
  it('resolves a simple alias', async () => {
    await writeAliases(pc);
    const r = await getent(pc, 'aliases postmaster');
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('postmaster: root');
  });

  it('lists multiple destinations', async () => {
    await writeAliases(pc);
    const r = await getent(pc, 'aliases webmaster');
    expect(r.output).toBe('webmaster: alice, bob');
  });

  it('enumerates the whole file', async () => {
    await writeAliases(pc);
    const r = await getent(pc, 'aliases');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/postmaster: root/);
    expect(r.output).toMatch(/staff: webmaster, carol/);
    expect(r.output).not.toMatch(/^#/m);
  });

  it('returns 2 for an unknown alias', async () => {
    await writeAliases(pc);
    const r = await getent(pc, 'aliases nosuchalias');
    expect(r.exitCode).toBe(2);
    expect(r.output).toBe('');
  });

  it('is empty, not an error, with no /etc/aliases at all', async () => {
    const r = await getent(pc, 'aliases');
    expect(r.output).toBe('');
  });

  it('honours continuation lines', async () => {
    await pc.executeCommand(
      `sudo sh -c 'printf "team: alice,\\n\\tbob,\\n\\tcarol\\n" > /etc/aliases'`);
    const r = await getent(pc, 'aliases team');
    expect(r.output).toBe('team: alice, bob, carol');
  });
});

/** A minimal MailDropFileSystem backed by a plain Map. */
function fakeFs(aliases: string | null): MailDropFileSystem & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    exists: (p) => p === '/etc/aliases' ? aliases !== null : written.has(p),
    readFile: (p) => p === '/etc/aliases' ? aliases : (written.get(p) ?? null),
    writeFile: (p, content, _uid, _gid, _umask, append) => {
      written.set(p, append ? (written.get(p) ?? '') + content : content);
      return true;
    },
  };
}

const ALIAS_FILE = [
  'postmaster: root',
  'webmaster: alice, bob',
  'staff: webmaster, carol',
  'root: root',
  'loopa: loopb',
  'loopb: loopa',
].join('\n');

const entry = { envelopeFrom: 'sender@example.com', receivedAt: 0, rawMessage: 'Subject: hi' };

describe('alias expansion at local delivery (P1)', () => {
  it('an address with no alias resolves to itself', () => {
    const fs = fakeFs(ALIAS_FILE);
    expect(resolveAliasRecipients(fs, 'dave@example.com')).toEqual(['dave@example.com']);
  });

  it('a simple alias expands to its destination', () => {
    const fs = fakeFs(ALIAS_FILE);
    expect(resolveAliasRecipients(fs, 'postmaster@example.com')).toEqual(['root']);
  });

  it('a multi-destination alias expands to all of them', () => {
    const fs = fakeFs(ALIAS_FILE);
    expect(resolveAliasRecipients(fs, 'webmaster').sort()).toEqual(['alice', 'bob']);
  });

  it('a chained alias expands recursively', () => {
    const fs = fakeFs(ALIAS_FILE);
    expect(resolveAliasRecipients(fs, 'staff').sort()).toEqual(['alice', 'bob', 'carol']);
  });

  it('root: root means the real root mailbox, not an infinite loop', () => {
    const fs = fakeFs(ALIAS_FILE);
    expect(resolveAliasRecipients(fs, 'root')).toEqual(['root']);
  });

  it('a two-step cycle terminates instead of recursing forever', () => {
    const fs = fakeFs(ALIAS_FILE);
    expect(resolveAliasRecipients(fs, 'loopa')).toEqual(['loopa']);
  });

  it('with no /etc/aliases the address is delivered untouched', () => {
    const fs = fakeFs(null);
    expect(resolveAliasRecipients(fs, 'postmaster')).toEqual(['postmaster']);
  });

  it('a message to an alias really lands in the destination mailboxes', () => {
    const fs = fakeFs(ALIAS_FILE);
    const ok = deliverLocalMessage(fs, 'webmaster@example.com', entry, { uid: 0, gid: 0 });
    expect(ok).toBe(true);
    expect(fs.written.has(mailboxPathFor('alice'))).toBe(true);
    expect(fs.written.has(mailboxPathFor('bob'))).toBe(true);
    // Nothing was written to a mailbox named after the alias itself.
    expect(fs.written.has(mailboxPathFor('webmaster'))).toBe(false);
  });

  it('one delivery event is published per real recipient', () => {
    const fs = fakeFs(ALIAS_FILE);
    const seen: string[] = [];
    bus.subscribe('smtp.delivery.local', (e) => seen.push(e.payload.recipient));
    deliverLocalMessage(fs, 'staff', entry, { uid: 0, gid: 0 }, bus);
    expect(seen.sort()).toEqual(['alice', 'bob', 'carol']);
  });

  it('delivery without aliases is unchanged — the pre-existing path', () => {
    const fs = fakeFs(null);
    const ok = deliverLocalMessage(fs, 'dave@example.com', entry, { uid: 0, gid: 0 });
    expect(ok).toBe(true);
    expect(fs.written.get(mailboxPathFor('dave'))).toMatch(/Subject: hi/);
  });
});
