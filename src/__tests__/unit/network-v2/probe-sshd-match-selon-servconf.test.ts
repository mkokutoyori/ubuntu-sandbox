/*
 * Les blocs Match de sshd_config selon OpenSSH 8.9p1.
 *
 * L'AUTORITE : `servconf.c` (V_8_9_P1). La table `keywords[]` marque chaque
 * directive SSHCFG_GLOBAL (section principale seulement) ou SSHCFG_ALL (aussi
 * dans un Match) ; `process_server_config_line` fait `fatal("%s line %d:
 * Directive '%s' is not allowed within a Match block")` quand le bloc n'est
 * pas actif et que la directive n'est pas SSHCFG_MATCH, ce que `sshd -t`
 * (qui n'a pas d'informations de connexion) rencontre pour tout Match sauf
 * `Match all`, que `match_cfg_line` declare actif (return 1). TrustedUserCAKeys,
 * RevokedKeys et CASignatureAlgorithms sont SSHCFG_ALL : leur valeur dans un
 * Match gagne pour les connexions qui le satisfont.
 *
 * Ecrite contre ces sources, avant l'implantation. 6 des 8 cas tombent avant
 * elle : les trois refus de `sshd -t` (Linux, casse saisie, Windows) et les
 * trois directives de certificats dans un Match. Passent des deux cotes le TEMOIN
 * (une directive SSHCFG_ALL dans un Match est acceptee) et `Match all`
 * (actif, donc accepte).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('sshd -t : directive reservee a la section principale', () => {
  async function linux(): Promise<LinuxServer> {
    const server = new LinuxServer('linux-server', 'SRV');
    server.powerOn();
    return server;
  }

  it('TEMOIN: une directive SSHCFG_ALL dans un Match est acceptee', async () => {
    const server = await linux();
    await server.executeCommand(`sh -c 'printf "Match User bob\\n    TrustedUserCAKeys /etc/ssh/ca.pub\\n    X11Forwarding no\\n" >> /etc/ssh/sshd_config'`);
    expect((await server.executeCommand('sshd -t')).trim()).toBe('');
  }, 60_000);

  it('HostKey dans un Match est refuse avec le texte de servconf.c', async () => {
    const server = await linux();
    await server.executeCommand(`sh -c 'printf "Match User bob\\n    HostKey /etc/ssh/other\\n" >> /etc/ssh/sshd_config'`);
    expect(await server.executeCommand('sshd -t')).toMatch(/^\/etc\/ssh\/sshd_config line \d+: Directive 'HostKey' is not allowed within a Match block$/m);
  }, 60_000);

  it('la casse saisie est reprise dans le message', async () => {
    const server = await linux();
    await server.executeCommand(`sh -c 'printf "Match Group staff\\n    hostcertificate /etc/ssh/x-cert.pub\\n" >> /etc/ssh/sshd_config'`);
    expect(await server.executeCommand('sshd -t')).toContain("Directive 'hostcertificate' is not allowed within a Match block");
  }, 60_000);

  it('Match all est actif : la directive reservee est acceptee', async () => {
    const server = await linux();
    await server.executeCommand(`sh -c 'printf "Match all\\n    PrintMotd no\\n" >> /etc/ssh/sshd_config'`);
    expect((await server.executeCommand('sshd -t')).trim()).toBe('');
  }, 60_000);

  it('sur Windows, HostCertificate apres le Match par defaut est refuse', async () => {
    const server = new WindowsPC('windows-pc', 'WSRV');
    server.powerOn();
    server.setCurrentUser('Administrator');
    await server.executeCommand('echo HostCertificate C:/ProgramData/ssh/ssh_host_ed25519_key-cert.pub>> C:\\ProgramData\\ssh\\sshd_config');
    expect(await server.executeCommand('sshd -t')).toMatch(/sshd_config line \d+: Directive 'HostCertificate' is not allowed within a Match block/i);
  }, 60_000);
});

describe('TrustedUserCAKeys, RevokedKeys et CASignatureAlgorithms dans un Match', () => {
  async function lab(target: 'linux' | 'windows') {
    const client = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const server = target === 'linux' ? new LinuxServer('linux-server', 'SRV') : new WindowsPC('windows-pc', 'WSRV');
    const sw = new GenericSwitch('switch-generic', 'SW');
    const mask = new SubnetMask('255.255.255.0');
    [client, server].forEach((device, index) => {
      new Cable(`c${index}`).connect(device.getPorts()[0] as never, sw.getPorts()[index]);
      device.getPorts()[0].configureIP(new IPAddress(`10.96.0.${10 + index * 10}`), mask);
    });
    client.powerOn();
    server.powerOn();
    if (server instanceof WindowsPC) {
      server.setCurrentUser('Administrator');
      await server.executeCommand('net user bob Passw0rd! /add');
      await server.executeCommand('net user alice Passw0rd! /add');
    } else {
      await server.executeCommand('useradd -m -s /bin/bash bob');
      await server.executeCommand('useradd -m -s /bin/bash alice');
    }
    await client.executeCommand("ssh-keygen -q -t ed25519 -N '' -C u@lab -f ~/id");
    await client.executeCommand("ssh-keygen -q -t ed25519 -N '' -C ca@lab -f ~/ca");
    const authority = (await client.executeCommand('cut -d" " -f1,2 ~/ca.pub')).trim();
    const caPath = target === 'linux' ? '/etc/ssh/ca.pub' : 'C:/ProgramData/ssh/ca.pub';
    if (server instanceof WindowsPC) {
      await server.executeCommand(`echo ${authority}> C:\\ProgramData\\ssh\\ca.pub`);
    } else {
      await server.executeCommand(`sh -c 'echo "${authority}" > /etc/ssh/ca.pub'`);
    }
    return { client, server, caPath };
  }

  async function append(server: LinuxServer | WindowsPC, lines: string[]): Promise<void> {
    if (server instanceof WindowsPC) {
      for (const line of lines) await server.executeCommand(`echo ${line}>> C:\\ProgramData\\ssh\\sshd_config`);
      await server.executeCommand('net stop sshd');
      await server.executeCommand('net start sshd');
    } else {
      for (const line of lines) await server.executeCommand(`sh -c 'echo "${line}" >> /etc/ssh/sshd_config'`);
      await server.executeCommand('systemctl restart ssh');
    }
  }

  const ssh = (user: string) => `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ~/id ${user}@10.96.0.20 whoami`;

  for (const target of ['linux', 'windows'] as const) {
    it(`${target} : TrustedUserCAKeys d'un Match User ne vaut que pour cet utilisateur`, async () => {
      const { client, server, caPath } = await lab(target);
      await append(server, ['Match User bob', `    TrustedUserCAKeys ${caPath}`]);
      await client.executeCommand('ssh-keygen -q -s ~/ca -I id -n bob,alice ~/id.pub');

      expect((await client.executeCommand(ssh('bob'))).toLowerCase()).toMatch(/^(wsrv\\)?bob$/m);
      expect(await client.executeCommand(ssh('alice'))).toContain('Permission denied');
    }, 120_000);
  }

  it('linux : CASignatureAlgorithms d\'un Match refuse une AC signant en ed25519', async () => {
    const { client, server, caPath } = await lab('linux');
    await append(server, [`TrustedUserCAKeys ${caPath}`, 'Match User bob', '    CASignatureAlgorithms rsa-sha2-512']);
    await client.executeCommand('ssh-keygen -q -s ~/ca -I id -n bob,alice ~/id.pub');

    expect(await client.executeCommand(ssh('bob'))).toContain('Permission denied');
    expect((await client.executeCommand(ssh('alice'))).trim()).toBe('alice');
  }, 120_000);
});
