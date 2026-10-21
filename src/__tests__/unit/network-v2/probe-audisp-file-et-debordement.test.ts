/**
 * La file du dispatcher d'auditd (audit 3.1.2, audisp/queue.c, audispd.c event_loop) : un plugin arrete (SIGSTOP)
 * ne lit plus son tube, le tube se remplit, le fil du dispatcher bloque sur l'ecriture, la file grossit jusqu'a
 * q_depth, puis overflow_action s'applique (IGNORE, SYSLOG limite a 5 messages, SUSPEND, SINGLE, HALT) ; SIGCONT
 * vide le tube et la file ; SIGUSR2 reprend apres SUSPEND ; /var/run/auditd.state donne profondeur, maximum,
 * debordement et suspension. La capacite du tube (socketpair AF_UNIX, tampon d'envoi 212992 octets, chaque message
 * comptant sa taille alignee sur 64 plus 576 octets de sk_buff et skb_shared_info) vient de la disposition du noyau
 * Linux, pas du source d'audit, que ce conteneur ne permet pas de verifier par execution : les sondes ne s'appuient
 * que sur l'existence d'une borne, pas sur sa valeur exacte, et disent en nombre d'evenements « beaucoup plus que ».
 *
 * Mesure avant : q_depth et overflow_action etaient lus, affiches, jamais appliques ; la profondeur courante valait
 * toujours 0 et un plugin arrete ne retenait rien. Avec src/network remis avant, 6 cas sur 7 tombent ; le temoin
 * (plugin en marche, profondeur 0, rien de perdu) passe dans les deux etats et borne les cas qui debordent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { SHIPPED_AUDITD_CONF } from '@/network/devices/linux/audit/daemon/AuditdConfFile';

const FILLER = 'x'.repeat(200);

async function rootHost(): Promise<LinuxPC> {
  const pc = new LinuxPC('AuditHost', 0, 0);
  await pc.executeCommand('sudo su -');
  return pc;
}

async function setup(pc: LinuxPC, overrides: Record<string, string>): Promise<void> {
  const body = SHIPPED_AUDITD_CONF.split('\n').map((line) => {
    const key = line.split(' = ')[0];
    return key in overrides ? `${key} = ${overrides[key]}` : line;
  }).join('\n').replace(/'/g, "'\\''");
  await pc.executeCommand(`printf '%s' '${body}' > /etc/audit/auditd.conf`);
  await pc.executeCommand('printf \'#!/bin/bash\\nwhile read line; do echo "$line" >> /var/tmp/collected.log; done\\n\' > /usr/local/sbin/collect.sh && chmod 755 /usr/local/sbin/collect.sh');
  await pc.executeCommand('printf \'active = yes\\ndirection = out\\npath = /usr/local/sbin/collect.sh\\ntype = always\\nformat = string\\n\' > /etc/audit/plugins.d/collect.conf');
  await pc.executeCommand('systemctl restart auditd');
}

const pluginPid = async (pc: LinuxPC): Promise<string> => (await pc.executeCommand('pgrep -x collect.sh')).trim().split('\n')[0];
const state = async (pc: LinuxPC): Promise<string> => {
  await pc.executeCommand('systemctl kill -s SIGCONT auditd');
  return pc.executeCommand('cat /var/run/auditd.state');
};
const send = async (pc: LinuxPC, count: number): Promise<void> => {
  for (let i = 0; i < count; i++) await pc.executeCommand(`auditctl -m ${FILLER}${i}`);
};
const journal = (pc: LinuxPC): Promise<string> => pc.executeCommand('journalctl -t auditd --no-pager');
const MANY = 400;

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('dispatcher queue', () => {
  it('witness: a running plugin keeps the queue empty and loses nothing', async () => {
    const pc = await rootHost();
    await setup(pc, { q_depth: '5' });
    await send(pc, 20);
    const st = await state(pc);
    expect(st).toContain('current plugin queue depth = 0');
    expect(st).toContain('plugin queue overflow detected = no');
    expect((await pc.executeCommand('grep -c xxxxxxxxxx /var/tmp/collected.log')).trim()).toBe('20');
  });

  it('a stopped plugin lets the queue fill up to q_depth, and the state file says so', async () => {
    const pc = await rootHost();
    await setup(pc, { q_depth: '5', overflow_action: 'IGNORE' });
    await pc.executeCommand(`kill -STOP ${await pluginPid(pc)}`);
    await send(pc, MANY);
    const st = await state(pc);
    expect(st).toContain('current plugin queue depth = 5');
    expect(st).toContain('max plugin queue depth used = 5');
    expect(st).toContain('plugin queue size = 5');
    expect(st).toContain('plugin queue overflow detected = yes');
  });

  it('overflow_action = SYSLOG reports the drop, at most five times then says it stops', async () => {
    const pc = await rootHost();
    await setup(pc, { q_depth: '5', overflow_action: 'SYSLOG' });
    await pc.executeCommand(`kill -STOP ${await pluginPid(pc)}`);
    await send(pc, MANY);
    const out = await journal(pc);
    expect((out.match(/queue to plugins is full - dropping event/g) ?? []).length).toBe(5);
    expect(out).toContain('auditd queue full reporting limit reached - ending dropped event notifications');
  });

  it('SIGCONT lets the plugin drain the pipe and the queue; what was dropped stays lost', async () => {
    const pc = await rootHost();
    await setup(pc, { q_depth: '5', overflow_action: 'IGNORE' });
    const pid = await pluginPid(pc);
    await pc.executeCommand(`kill -STOP ${pid}`);
    await send(pc, MANY);
    await pc.executeCommand(`kill -CONT ${pid}`);
    expect(await state(pc)).toContain('current plugin queue depth = 0');
    const received = Number((await pc.executeCommand('grep -c xxxxxxxxxx /var/tmp/collected.log')).trim());
    expect(received).toBeGreaterThan(5);
    expect(received).toBeLessThan(MANY);
  });

  it('overflow_action = SUSPEND stops passing events to plugins until SIGUSR2', async () => {
    const pc = await rootHost();
    await setup(pc, { q_depth: '5', overflow_action: 'SUSPEND' });
    const pid = await pluginPid(pc);
    await pc.executeCommand(`kill -STOP ${pid}`);
    await send(pc, MANY);
    expect(await journal(pc)).toContain('Auditd is suspending event passing to plugins due to overflowing its queue.');
    expect(await state(pc)).toContain('plugin queueing suspended = yes');
    await pc.executeCommand(`kill -CONT ${pid}`);
    const before = await pc.executeCommand('wc -l < /var/tmp/collected.log');
    await send(pc, 3);
    expect(await pc.executeCommand('wc -l < /var/tmp/collected.log')).toBe(before);
    await pc.executeCommand('systemctl kill -s SIGUSR2 auditd');
    expect(await state(pc)).toContain('plugin queueing suspended = no');
    await send(pc, 3);
    expect(Number((await pc.executeCommand('wc -l < /var/tmp/collected.log')).trim())).toBeGreaterThan(Number(before.trim()));
  });

  it('overflow_action = SINGLE changes the machine to rescue mode', async () => {
    const pc = await rootHost();
    await setup(pc, { q_depth: '5', overflow_action: 'SINGLE' });
    await pc.executeCommand(`kill -STOP ${await pluginPid(pc)}`);
    await send(pc, MANY);
    expect(await journal(pc)).toContain('Auditd is now changing the system to single user mode due to overflowing its queue');
    expect(await pc.executeCommand('systemctl is-active cron')).toBe('inactive');
  });

  it('overflow_action = HALT halts the machine', async () => {
    const pc = await rootHost();
    await setup(pc, { q_depth: '5', overflow_action: 'HALT' });
    await pc.executeCommand(`kill -STOP ${await pluginPid(pc)}`);
    await send(pc, MANY);
    expect(await journal(pc)).toContain('Auditd is now halting the system due to overflowing its queue');
    expect(await pc.executeCommand('systemctl is-active cron')).toBe('inactive');
  });
});
