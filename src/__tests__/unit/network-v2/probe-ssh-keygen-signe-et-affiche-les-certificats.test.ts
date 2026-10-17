/*
 * `ssh-keygen -s` signe un certificat, `-L` l'affiche, comme OpenSSH 8.9p1.
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `PROTOCOL.certkeys` : le certificat « <algo>-cert-v01@
 *   openssh.com » porte nonce, cle publique, serie, type (1 utilisateur, 2
 *   hote), identifiant, principaux, validite, options critiques,
 *   extensions, cle de l'AC et signature de l'AC sur tout ce qui precede ;
 * - `ssh-keygen.c` : `do_ca_sign` ecrit <cle>-cert.pub et annonce sur la
 *   sortie d'erreur « Signed user key <f>: id "<id>" serial <n> for
 *   <principaux> valid <validite> » ; sans `-I`, « Must specify key id (-I)
 *   when certifying » ; `-V` accepte +duree, depart:fin, always, forever ;
 *   `-z +n` incremente la serie par fichier ; `-O` accepte clear, permit-/
 *   no-*, force-command=, source-address=, extension:, critical: ;
 *   par defaut un certificat utilisateur porte permit-X11-forwarding,
 *   permit-agent-forwarding, permit-port-forwarding, permit-pty,
 *   permit-user-rc, un certificat d'hote (-h) aucune extension ;
 *   `print_cert` (-L) ecrit Type, Public key, Signing CA, Key ID, Serial,
 *   Valid, Principals, Critical Options, Extensions ;
 * - `sshkey.c` (`sshkey_format_cert_validity`) : forever, « before … »,
 *   « after … », « from … to … ».
 *
 * Ecrite contre ces sources, avant l'implantation. 16 des 17 cas tombent
 * avant elle (« certificates are not simulated »). Passe des deux cotes le
 * TEMOIN `-U` : la signature par l'agent reste refusee, dans les mots du
 * refus.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

async function lab(caType = 'ed25519', userType = 'ed25519'): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await pc.executeCommand(`ssh-keygen -q -t ${caType} -N '' -C ca@lab -f ~/ca`);
  await pc.executeCommand(`ssh-keygen -q -t ${userType} -N '' -C alice@lab -f ~/user`);
  return pc;
}

const SIGN = 'ssh-keygen -s ~/ca -I alice-key -n alice,deploy ~/user.pub';

describe('ssh-keygen -s', () => {
  it('TEMOIN: -U sans agent est refuse', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -U -s ~/ca -I id ~/user.pub')).toContain('not simulated');
  }, 60_000);

  it('ecrit <cle>-cert.pub et l\'annonce', async () => {
    const pc = await lab();
    const out = await pc.executeCommand(SIGN);

    expect(out).toBe('Signed user key /home/user/user-cert.pub: id "alice-key" serial 0 for alice,deploy valid forever');
    const line = (await pc.executeCommand('cat ~/user-cert.pub')).trim();
    expect(line.startsWith('ssh-ed25519-cert-v01@openssh.com AAAA')).toBe(true);
    expect(line.endsWith(' alice@lab')).toBe(true);
  }, 60_000);

  it('-L affiche le certificat comme print_cert', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const shown = await pc.executeCommand('ssh-keygen -L -f ~/user-cert.pub');

    expect(shown).toMatch(/^\/home\/user\/user-cert\.pub:\n/);
    expect(shown).toContain('        Type: ssh-ed25519-cert-v01@openssh.com user certificate');
    expect(shown).toMatch(/ {8}Public key: ED25519-CERT SHA256:[A-Za-z0-9+/]{43}/);
    expect(shown).toMatch(/ {8}Signing CA: ED25519 SHA256:[A-Za-z0-9+/]{43} \(using ssh-ed25519\)/);
    expect(shown).toContain('        Key ID: "alice-key"');
    expect(shown).toContain('        Serial: 0');
    expect(shown).toContain('        Valid: forever');
    expect(shown).toContain('        Principals: \n                alice\n                deploy');
    expect(shown).toContain('        Critical Options: (none)');
    expect(shown).toContain('        Extensions: \n                permit-X11-forwarding\n                permit-agent-forwarding\n                permit-port-forwarding\n                permit-pty\n                permit-user-rc');
  }, 60_000);

  it('l\'empreinte de l\'AC est celle de sa cle publique', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const fingerprint = (await pc.executeCommand('ssh-keygen -l -f ~/ca.pub')).split(' ')[1];

    expect(await pc.executeCommand('ssh-keygen -L -f ~/user-cert.pub')).toContain(`Signing CA: ED25519 ${fingerprint}`);
  }, 60_000);

  it('sans -I, refuse', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -s ~/ca -n alice ~/user.pub; echo "rc=$?"'))
      .toContain('Must specify key id (-I) when certifying\nrc=255');
  }, 60_000);

  it('sans fichier a certifier, donne l\'usage', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -s ~/ca -I id; echo "rc=$?"')).toMatch(/Too few arguments\.[\s\S]*rc=1/);
  }, 60_000);

  it('-h signe un certificat d\'hote sans extensions', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('ssh-keygen -s ~/ca -h -I host1 -n server.lab ~/user.pub');
    expect(out).toContain('Signed host key /home/user/user-cert.pub: id "host1" serial 0 for server.lab valid forever');

    const shown = await pc.executeCommand('ssh-keygen -L -f ~/user-cert.pub');
    expect(shown).toContain('host certificate');
    expect(shown).toContain('        Extensions: (none)');
  }, 60_000);

  it('-V +52w1d borne la validite, -V always:forever la leve', async () => {
    const pc = await lab();
    const bounded = await pc.executeCommand('ssh-keygen -s ~/ca -I id -V +52w1d ~/user.pub');
    expect(bounded).toMatch(/valid from \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} to \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    const open = await pc.executeCommand('ssh-keygen -s ~/ca -I id -V always:forever ~/user.pub');
    expect(open).toMatch(/valid forever$/);
  }, 60_000);

  it('-V avec une date absolue : « before » et « after »', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -s ~/ca -I id -V always:20990101 ~/user.pub'))
      .toMatch(/valid before 2099-01-01T00:00:00$/);
    expect(await pc.executeCommand('ssh-keygen -s ~/ca -I id -V 20200101:forever ~/user.pub'))
      .toMatch(/valid after 2020-01-01T00:00:00$/);
  }, 60_000);

  it('-V invalide est refuse', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -s ~/ca -I id -V bogus ~/user.pub')).toContain('Invalid certificate life specification bogus');
    expect(await pc.executeCommand('ssh-keygen -s ~/ca -I id -V 20300101:20200101 ~/user.pub')).toContain('Empty certificate validity interval');
  }, 60_000);

  it('-z fixe la serie, -z +N l\'incremente d\'un fichier a l\'autre', async () => {
    const pc = await lab();
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/second");
    const out = await pc.executeCommand('ssh-keygen -s ~/ca -I id -z +41 ~/user.pub ~/second.pub');

    expect(out).toContain('user-cert.pub: id "id" serial 41');
    expect(out).toContain('second-cert.pub: id "id" serial 42');
  }, 60_000);

  it('-O : clear, permit-pty, force-command, source-address', async () => {
    const pc = await lab();
    await pc.executeCommand("ssh-keygen -s ~/ca -I id -O clear -O permit-pty -O force-command=/bin/date -O source-address=10.0.0.0/8 ~/user.pub");
    const shown = await pc.executeCommand('ssh-keygen -L -f ~/user-cert.pub');

    expect(shown).toContain('        Critical Options: \n                force-command /bin/date\n                source-address 10.0.0.0/8');
    expect(shown).toContain('        Extensions: \n                permit-pty');
  }, 60_000);

  it('-O inconnu est refuse', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -s ~/ca -I id -O bogus ~/user.pub')).toContain('Unsupported certificate option "bogus"');
  }, 60_000);

  it('une AC RSA signe en rsa-sha2-512, -t rsa-sha2-256 le change', async () => {
    const pc = await lab('rsa', 'ed25519');
    await pc.executeCommand("ssh-keygen -s ~/ca -I id ~/user.pub");
    expect(await pc.executeCommand('ssh-keygen -L -f ~/user-cert.pub')).toContain('Signing CA: RSA SHA256:');
    expect(await pc.executeCommand('ssh-keygen -L -f ~/user-cert.pub')).toContain('(using rsa-sha2-512)');

    await pc.executeCommand("ssh-keygen -s ~/ca -t rsa-sha2-256 -I id ~/user.pub");
    expect(await pc.executeCommand('ssh-keygen -L -f ~/user-cert.pub')).toContain('(using rsa-sha2-256)');
  }, 120_000);

  it('une cle RSA et une cle ECDSA se certifient', async () => {
    for (const type of ['rsa', 'ecdsa']) {
      const pc = await lab('ed25519', type);
      const out = await pc.executeCommand("ssh-keygen -s ~/ca -I id ~/user.pub");
      expect(out, type).toContain('Signed user key');
      expect(await pc.executeCommand('ssh-keygen -L -f ~/user-cert.pub'), type)
        .toContain(`Public key: ${type === 'rsa' ? 'RSA' : 'ECDSA'}-CERT SHA256:`);
    }
  }, 120_000);

  it('un certificat ne se recertifie pas', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    expect(await pc.executeCommand('ssh-keygen -s ~/ca -I id ~/user-cert.pub')).toContain('cannot be certified');
  }, 60_000);

  it('-L refuse un fichier qui n\'est pas un certificat', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -L -f ~/user.pub; echo "rc=$?"')).toContain('/home/user/user.pub:1 is not a certificate\nrc=1');
  }, 60_000);
});

describe('ssh-keygen -l sur un certificat', () => {
  it('ecrit l\'empreinte du certificat, pas celle de la cle, avec (TYPE-CERT)', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const line = (await pc.executeCommand('ssh-keygen -l -f ~/user-cert.pub')).trim();
    const plain = (await pc.executeCommand('ssh-keygen -l -f ~/user.pub')).trim();

    expect(line).toMatch(/^256 SHA256:[A-Za-z0-9+/]{43} alice@lab \(ED25519-CERT\)$/);
    expect(line.split(' ')[1]).not.toBe(plain.split(' ')[1]);
  }, 60_000);
});
