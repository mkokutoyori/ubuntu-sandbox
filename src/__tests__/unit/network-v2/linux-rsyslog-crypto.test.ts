/*
 * Probe - encrypted omfile output on a simulated Linux host, read back with rscryutil (tools/rscryutil.c): the log file holds
 * ciphertext (cat shows no readable line, stat counts whole cipher blocks), "<log>.encinfo" is mode 0600 and records the IV and the
 * END offset, and `rscryutil -k <keyfile> <log>` decrypts the blocks, strips the NUL padding and prints the lines.  The key may come
 * from a file, from the config (with the runtime's warning) or from a key program that answers "RSYSLOG-KEY-PROVIDER:0", the length
 * and the key.  rscryutil refuses what the tool refuses - a key of the wrong length, an unknown algorithm or mode, a missing key,
 * a keyfile it must not overwrite without --force - and writes keyfiles with mode 0400.  With the ossl library the NUL padding is
 * NOT stripped (osslDecryptBlock writes the decrypted buffer as it is), which the probe pins.
 * Measured before the port (git stash push -- src/network): 9 of the 10 cases fall - omfile wrote clear text and rscryutil did not
 * exist.  The one that passes either way is the WITNESS: without cry.provider the file is readable with cat.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const MODULES = '/usr/lib/x86_64-linux-gnu/rsyslog';
const KEY = '0123456789abcdef';

function machine(): LinuxServer {
  const host = new LinuxServer('linux-server', 'host1', 0, 0);
  host.powerOn();
  const executor = (host as unknown as { executor: LinuxCommandExecutor }).executor;
  for (const library of ['lmcry_gcry', 'lmcry_ossl']) executor.vfs.writeFile(`${MODULES}/${library}.so`, '', 0, 0, 0o022);
  return host;
}

async function configure(host: LinuxServer, text: string): Promise<void> {
  await host.executeCommand(`printf '${text.replace(/'/g, "'\\''")}\\n' > /etc/rsyslog.d/40-test.conf`);
  await host.executeCommand('systemctl restart rsyslog');
}

async function log(host: LinuxServer, text: string): Promise<void> {
  await host.executeCommand(`logger -p local4.info -t probe ${text}`);
}

const encrypted = (parameters: string): string => `local4.* action(type="omfile" file="/var/log/enc.log" ${parameters})`;

async function lab(parameters: string, keyText = KEY): Promise<LinuxServer> {
  const host = machine();
  await host.executeCommand(`printf '${keyText}' > /etc/enc.key`);
  await configure(host, encrypted(`cry.provider="gcry" cry.keyfile="/etc/enc.key" ${parameters}`));
  await log(host, 'first-line');
  await log(host, 'second-line');
  return host;
}

describe('encrypted omfile output', () => {
  it('witness: without cry.provider the log is readable', async () => {
    const host = machine();
    await configure(host, 'local4.* /var/log/enc.log');
    await log(host, 'first-line');
    expect(await host.executeCommand('cat /var/log/enc.log')).toContain('probe: first-line');
  }, 60_000);

  it('the file holds whole cipher blocks and none of the text, the encinfo file is private', async () => {
    const host = await lab('');
    expect(await host.executeCommand('cat /var/log/enc.log')).not.toContain('first-line');
    const size = Number((await host.executeCommand('stat -c %s /var/log/enc.log')).trim());
    expect(size).toBeGreaterThan(0);
    expect(size % 16).toBe(0);
    expect(await host.executeCommand('stat -c "%a" /var/log/enc.log.encinfo')).toContain('600');
    expect(await host.executeCommand('cat /var/log/enc.log.encinfo')).toMatch(/^FILETYPE:rsyslog-enrcyption-info\nIV:[0-9a-f]{32}$/);
  }, 60_000);

  it('rscryutil decrypts the blocks once the file is closed and the END offset is known', async () => {
    const host = await lab('');
    await host.executeCommand('systemctl stop rsyslog');
    expect(await host.executeCommand('cat /var/log/enc.log.encinfo')).toMatch(/\nEND:\d+$/);
    const out = await host.executeCommand('rscryutil -k /etc/enc.key /var/log/enc.log');
    expect(out).toContain('probe: first-line');
    expect(out).toContain('probe: second-line');
    expect(out).not.toContain('\0');
  }, 60_000);

  it('while the file is still open rscryutil prints what it can, then reports the missing END record', async () => {
    const host = await lab('');
    const out = await host.executeCommand('rscryutil -k /etc/enc.key /var/log/enc.log 2>&1');
    expect(out).toContain('probe: first-line');
    expect(out).toContain('error 1 processing file /var/log/enc.log');
  }, 60_000);

  it('an algorithm and a mode chosen in the configuration are the ones rscryutil needs', async () => {
    const host = machine();
    await host.executeCommand('printf "0123456789abcdef0123456789abcdef" > /etc/enc.key');
    await configure(host, encrypted('cry.provider="gcry" cry.keyfile="/etc/enc.key" cry.algo="TWOFISH" cry.mode="CFB"'));
    await log(host, 'twofish-line');
    await host.executeCommand('systemctl stop rsyslog');
    expect(await host.executeCommand('rscryutil -k /etc/enc.key /var/log/enc.log 2>&1')).not.toContain('twofish-line');
    expect(await host.executeCommand('rscryutil -k /etc/enc.key -a TWOFISH -m CFB /var/log/enc.log')).toContain('probe: twofish-line');
  }, 60_000);

  it('a key program answering RSYSLOG-KEY-PROVIDER:0 supplies the key', async () => {
    const host = machine();
    await host.executeCommand(`printf '#!/bin/sh\\necho RSYSLOG-KEY-PROVIDER:0\\necho 16\\nprintf ${KEY}\\n' > /usr/local/bin/keys && chmod +x /usr/local/bin/keys`);
    await configure(host, encrypted('cry.provider="gcry" cry.keyprogram="/usr/local/bin/keys"'));
    await log(host, 'program-line');
    await host.executeCommand('systemctl stop rsyslog');
    await host.executeCommand(`printf '${KEY}' > /etc/enc.key`);
    expect(await host.executeCommand('rscryutil -k /etc/enc.key /var/log/enc.log')).toContain('probe: program-line');
  }, 60_000);

  it('the ossl library leaves the NUL padding in the decrypted text', async () => {
    const host = machine();
    await host.executeCommand(`printf '${KEY}' > /etc/enc.key`);
    await configure(host, encrypted('cry.provider="ossl" cry.keyfile="/etc/enc.key"'));
    await log(host, 'ossl-line');
    await host.executeCommand('systemctl stop rsyslog');
    const plain = await host.executeCommand('rscryutil -l ossl -k /etc/enc.key /var/log/enc.log');
    expect(plain).toContain('probe: ossl-line');
    expect(plain).toContain('\0');
  }, 60_000);
});

describe('rscryutil', () => {
  it('writes a random keyfile with mode 0400 and refuses to overwrite it without --force', async () => {
    const host = machine();
    expect(await host.executeCommand('rscryutil --generate-random-key 16 --write-keyfile /etc/new.key 2>&1; echo "exit=$?"')).toContain('exit=0');
    expect(await host.executeCommand('stat -c "%a %s" /etc/new.key')).toContain('400 16');
    const again = await host.executeCommand('rscryutil -r 16 -W /etc/new.key 2>&1; echo "exit=$?"');
    expect(again).toContain('error opening keyfile');
    expect(again).toContain('exit=1');
    expect(await host.executeCommand('rscryutil -r 16 -W /etc/new.key -f 2>&1; echo "exit=$?"')).toContain('exit=0');
  }, 60_000);

  it('refuses a key of the wrong length, an unknown algorithm or mode, and a missing key', async () => {
    const host = await lab('');
    await host.executeCommand('systemctl stop rsyslog');
    expect(await host.executeCommand('rscryutil -K short /var/log/enc.log 2>&1')).toContain('invalid key length; key is 5 characters, but exactly 16 characters are required');
    expect(await host.executeCommand('rscryutil -k /etc/enc.key -a ROT13 /var/log/enc.log 2>&1')).toContain('ERROR: algorithm "ROT13" is not known/supported');
    expect(await host.executeCommand('rscryutil -k /etc/enc.key -m XTS /var/log/enc.log 2>&1')).toContain('ERROR: cipher mode "XTS" is not known/supported');
    expect(await host.executeCommand('rscryutil /var/log/enc.log 2>&1')).toContain('ERROR: key must be set via some method');
    expect(await host.executeCommand('rscryutil -k /etc/enc.key -l nss /var/log/enc.log 2>&1')).toContain('invalid option for lib: nss');
  }, 60_000);

  it('says so when the encinfo file or the log is missing', async () => {
    const host = await lab('');
    await host.executeCommand('rm /var/log/enc.log.encinfo');
    expect(await host.executeCommand('rscryutil -k /etc/enc.key /var/log/enc.log 2>&1')).toContain('/var/log/enc.log.encinfo: No such file or directory');
    expect(await host.executeCommand('rscryutil -k /etc/enc.key /var/log/absent.log 2>&1')).toContain('/var/log/absent.log: No such file or directory');
  }, 60_000);
});
