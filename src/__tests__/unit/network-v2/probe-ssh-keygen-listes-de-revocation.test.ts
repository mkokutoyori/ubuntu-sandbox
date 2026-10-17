/*
 * `ssh-keygen -k` ecrit une liste de revocation, `-Q` l'interroge, sshd la
 * lit (RevokedKeys), comme OpenSSH 8.9p1.
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `PROTOCOL.krl` : en-tete « SSHKRL\n\0 », sections de
 *   certificats (liste, intervalle ou bitmap de numeros de serie, identifiants
 *   de cle, par AC ou pour toute AC), cles explicites, empreintes SHA1 et
 *   SHA256 ;
 * - `ssh-keygen.c` (`do_gen_krl`, `update_krl_from_file`, `do_check_krl`) :
 *   « Revoking from <f> » hors -q ; lignes « serial: n[-m] », « id: x »,
 *   « key: », « sha1: », « sha256: », « hash: SHA256:<base64> » ou une cle
 *   nue ; serial et id exigent -s <AC> ou -s none ; « KRL generation requires
 *   an output file », « KRL "<f>" does not exist » avec -u ; -Q ecrit
 *   « <f> (<commentaire>): ok » ou « … REVOKED » et sort en 1 si une cle est
 *   revoquee, -Q -l ecrit d'abord le contenu (`krl_dump`) ;
 * - `krl.c` : `ssh_krl_check_key` examine la cle puis son AC ; un numero de
 *   serie nul n'est jamais revoque ; `ssh_krl_from_blob` refuse un fichier
 *   sans l'en-tete ;
 * - `auth2-pubkey.c` : RevokedKeys accepte une KRL et refuse « Authentication
 *   key … revoked by file <f> ».
 *
 * Ecrite contre ces sources, avant l'implantation. 15 des 17 cas tombent
 * avant elle (« key revocation lists are not simulated »). Passent des deux
 * cotes les deux TEMOINS : `-Q` sur un fichier qui n'est pas une KRL (refuse
 * avant par le meme motif) et sshd sans RevokedKeys.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function keys(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C ca@lab -f ~/ca");
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C alice@lab -f ~/a");
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C bob@lab -f ~/b");
  return pc;
}

async function revoke(pc: LinuxPC, spec: string, options = ''): Promise<string> {
  await pc.executeCommand(`printf '${spec}\\n' > ~/spec`);
  return pc.executeCommand(`ssh-keygen -k -f ~/krl ${options} ~/spec`);
}

describe('ssh-keygen -k et -Q', () => {
  it('TEMOIN: -Q refuse un fichier qui n\'est pas une KRL', async () => {
    const pc = await keys();
    expect(await pc.executeCommand('ssh-keygen -Q -f ~/a.pub ~/b.pub; echo "rc=$?"')).toContain('rc=255');
  }, 60_000);

  it('une cle explicite est revoquee, l\'autre non, et le code de sortie le dit', async () => {
    const pc = await keys();
    const publicLine = (await pc.executeCommand('cut -d" " -f1,2 ~/a.pub')).trim();
    expect(await revoke(pc, `key: ${publicLine}`)).toBe('Revoking from /home/user/spec');

    const out = await pc.executeCommand('ssh-keygen -Q -f ~/krl ~/a.pub ~/b.pub; echo "rc=$?"');
    expect(out).toContain('/home/user/a.pub (alice@lab): REVOKED');
    expect(out).toContain('/home/user/b.pub (bob@lab): ok');
    expect(out).toContain('rc=1');
  }, 60_000);

  it('le fichier commence par l\'en-tete SSHKRL', async () => {
    const pc = await keys();
    await revoke(pc, `key: ${(await pc.executeCommand('cut -d" " -f1,2 ~/a.pub')).trim()}`);
    expect((await pc.executeCommand('head -c 6 ~/krl')).trim()).toBe('SSHKRL');
  }, 60_000);

  it('sha1:, sha256: et une cle nue revoquent aussi', async () => {
    const pc = await keys();
    const line = (name: string) => pc.executeCommand(`cut -d" " -f1,2 ~/${name}.pub`).then((text) => text.trim());
    await revoke(pc, `sha1: ${await line('a')}\\nsha256: ${await line('b')}`);

    const out = await pc.executeCommand('ssh-keygen -Q -f ~/krl ~/a.pub ~/b.pub');
    expect(out).toContain('a.pub (alice@lab): REVOKED');
    expect(out).toContain('b.pub (bob@lab): REVOKED');
  }, 60_000);

  it('hash: SHA256:<base64> revoque la cle de cette empreinte', async () => {
    const pc = await keys();
    const fingerprint = (await pc.executeCommand('ssh-keygen -l -f ~/a.pub')).split(' ')[1];
    await revoke(pc, `hash: ${fingerprint}`);

    expect(await pc.executeCommand('ssh-keygen -Q -f ~/krl ~/a.pub')).toContain('REVOKED');
  }, 60_000);

  it('-Q -l ecrit le contenu avant les verdicts', async () => {
    const pc = await keys();
    await pc.executeCommand("ssh-keygen -s ~/ca -I id1 -z 5 ~/a.pub");
    await revoke(pc, 'serial: 5-9\\nserial: 20\\nid: former-employee', '-s ~/ca.pub -z 3 -C "lab list"');
    const out = await pc.executeCommand('ssh-keygen -Q -l -f ~/krl');

    expect(out).toContain('# KRL version 3');
    expect(out).toMatch(/# Generated at \d{8}T\d{6}/);
    expect(out).toContain('# Comment: lab list');
    expect(out).toMatch(/# CA key ssh-ed25519 SHA256:/);
    expect(out).toContain('serial: 5-9');
    expect(out).toContain('serial: 20');
    expect(out).toContain('id: former-employee');
  }, 60_000);

  it('un certificat dont le numero de serie est revoque l\'est, un autre non', async () => {
    const pc = await keys();
    await pc.executeCommand('ssh-keygen -s ~/ca -I one -z 7 ~/a.pub');
    await pc.executeCommand('ssh-keygen -s ~/ca -I two -z 30 ~/b.pub');
    await revoke(pc, 'serial: 5-9', '-s ~/ca.pub');

    const out = await pc.executeCommand('ssh-keygen -Q -f ~/krl ~/a-cert.pub ~/b-cert.pub');
    expect(out).toContain('a-cert.pub (alice@lab): REVOKED');
    expect(out).toContain('b-cert.pub (bob@lab): ok');
  }, 60_000);

  it('un identifiant de cle revoque, et « -s none » vaut pour toute AC', async () => {
    const pc = await keys();
    await pc.executeCommand('ssh-keygen -s ~/ca -I former-employee -z 99 ~/a.pub');
    await revoke(pc, 'id: former-employee', '-s none');

    expect(await pc.executeCommand('ssh-keygen -Q -l -f ~/krl ~/a-cert.pub')).toContain('# Wildcard CA');
    expect(await pc.executeCommand('ssh-keygen -Q -f ~/krl ~/a-cert.pub')).toContain('REVOKED');
  }, 60_000);

  it('un numero de serie nul n\'est jamais revoque', async () => {
    const pc = await keys();
    await pc.executeCommand('ssh-keygen -s ~/ca -I zero ~/a.pub');
    await revoke(pc, 'serial: 0-4', '-s ~/ca.pub');

    expect(await pc.executeCommand('ssh-keygen -Q -f ~/krl ~/a-cert.pub')).toContain(': ok');
  }, 60_000);

  it('serial: sans AC est refuse', async () => {
    const pc = await keys();
    expect(await revoke(pc, 'serial: 5')).toContain('revoking certificates by serial number requires specification of a CA key');
  }, 60_000);

  it('une ligne inexploitable donne le fichier et le numero de ligne', async () => {
    const pc = await keys();
    expect(await revoke(pc, 'serial: 9-3', '-s none')).toContain('/home/user/spec:1: invalid serial range 9:3');
    expect(await revoke(pc, 'key: not a key')).toContain('/home/user/spec:1: invalid key: invalid format');
  }, 60_000);

  it('-u complete une KRL existante, -k sans -f et -u sur un fichier absent sont refuses', async () => {
    const pc = await keys();
    await revoke(pc, `key: ${(await pc.executeCommand('cut -d" " -f1,2 ~/a.pub')).trim()}`);
    await revoke(pc, `key: ${(await pc.executeCommand('cut -d" " -f1,2 ~/b.pub')).trim()}`, '-u');
    const out = await pc.executeCommand('ssh-keygen -Q -f ~/krl ~/a.pub ~/b.pub');
    expect(out).toContain('a.pub (alice@lab): REVOKED');
    expect(out).toContain('b.pub (bob@lab): REVOKED');

    expect(await pc.executeCommand('ssh-keygen -k ~/spec')).toContain('KRL generation requires an output file');
    expect(await pc.executeCommand('ssh-keygen -k -u -f ~/absent ~/spec')).toContain('KRL "/home/user/absent" does not exist');
  }, 60_000);

  it('-q se tait', async () => {
    const pc = await keys();
    expect((await revoke(pc, 'serial: 5', '-q -s none')).trim()).toBe('');
  }, 60_000);

  it('un fichier qui n\'est pas une KRL est refuse par -Q', async () => {
    const pc = await keys();
    expect(await pc.executeCommand('ssh-keygen -Q -f ~/a.pub ~/b.pub')).toContain('Invalid KRL file /home/user/a.pub: KRL file has invalid magic number');
  }, 60_000);
});

describe('sshd RevokedKeys avec une KRL', () => {
  async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
    const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    await srv.executeCommand('useradd -m -s /bin/bash alice');
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C alice@lab -f ~/id");
    await srv.executeCommand("ssh-keygen -q -t ed25519 -N '' -f /root/ca");
    const publicKey = (await pc.executeCommand('cat ~/id.pub')).trim();
    await srv.executeCommand(`mkdir -p /home/alice/.ssh && printf '%s\\n' '${publicKey}' > /home/alice/.ssh/authorized_keys && chown -R alice:alice /home/alice/.ssh && chmod 700 /home/alice/.ssh && chmod 600 /home/alice/.ssh/authorized_keys`);
    await srv.executeCommand(`printf '%s\\n' '${publicKey.split(' ').slice(0, 2).join(' ')}' > /root/id.pub`);
    return { pc, srv };
  }

  const SSH = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ~/id alice@10.0.0.2 whoami';

  it('TEMOIN: sans RevokedKeys la cle ouvre une session', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('systemctl restart ssh');
    expect((await pc.executeCommand(SSH)).trim()).toBe('alice');
  }, 120_000);

  it('une cle listee dans la KRL est refusee', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand("printf 'key: %s\\n' \"$(cat /root/id.pub)\" > /root/spec");
    await srv.executeCommand('ssh-keygen -k -q -f /etc/ssh/revoked.krl /root/spec');
    await srv.executeCommand("printf 'RevokedKeys /etc/ssh/revoked.krl\\n' >> /etc/ssh/sshd_config");
    await srv.executeCommand('systemctl restart ssh');

    expect(await pc.executeCommand(SSH)).toContain('Permission denied');
    expect(await srv.executeCommand('cat /var/log/auth.log')).toMatch(/error: Authentication key ED25519 SHA256:[A-Za-z0-9+/]{43} revoked by file \/etc\/ssh\/revoked\.krl/);
  }, 120_000);

  it('un certificat dont le numero de serie est revoque est refuse', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('cp /root/id.pub /root/idc.pub && ssh-keygen -q -s /root/ca -I alice-key -n alice -z 7 /root/idc.pub');
    const certificate = (await srv.executeCommand('cat /root/idc-cert.pub')).trim();
    await pc.executeCommand(`printf '%s\\n' '${certificate}' > ~/id-cert.pub`);
    await srv.executeCommand("printf 'serial: 5-9\\n' > /root/spec");
    await srv.executeCommand('ssh-keygen -k -q -s /root/ca.pub -f /etc/ssh/revoked.krl /root/spec');
    await srv.executeCommand("printf 'TrustedUserCAKeys /root/ca.pub\\nRevokedKeys /etc/ssh/revoked.krl\\n' >> /etc/ssh/sshd_config");
    await srv.executeCommand("printf '' > /home/alice/.ssh/authorized_keys");
    await srv.executeCommand('systemctl restart ssh');

    expect(await pc.executeCommand(SSH)).toContain('Permission denied');
    expect(await srv.executeCommand('cat /var/log/auth.log')).toMatch(/error: Authentication key ED25519-CERT SHA256:[A-Za-z0-9+/]{43} revoked by file \/etc\/ssh\/revoked\.krl/);
  }, 120_000);
});
