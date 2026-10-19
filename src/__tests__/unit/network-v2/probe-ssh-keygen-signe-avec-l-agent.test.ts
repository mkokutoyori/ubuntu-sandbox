/*
 * `ssh-keygen -s ca.pub -U` : le certificat est signe par l'agent, la cle
 * privee de l'AC n'est pas lue sur le disque. Linux (ssh-agent) et Windows
 * (service ssh-agent).
 *
 * L'AUTORITE : OpenSSH 8.9p1, `ssh-keygen.c` (do_ca_sign, agent_signer) :
 * avec -U, le fichier de -s est lu comme cle PUBLIQUE ; l'agent doit la
 * detenir (`ssh_get_authentication_socket`, `ssh_fetch_identitylist`,
 * `sshkey_equal`), sinon « Cannot use public key for CA signature: agent not
 * present » (pas de SSH_AUTH_SOCK) ou « CA key <chemin> not found in agent » ;
 * la signature vient de `ssh_agent_sign` avec l'algorithme demande
 * (rsa-sha2-512 par defaut pour RSA). `ssh_err` donne « agent not present ».
 *
 * Ecrite contre ces sources, avant l'implantation. 5 des 6 cas tombent avant
 * (-U etait refuse : « certificates signed by the agent are not simulated »).
 * Passe des deux cotes le TEMOIN : sans agent la signature par fichier marche.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function linux(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C ca@lab -f ~/ca");
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C bob@lab -f ~/id");
  return pc;
}

describe('linux', () => {
  it('TEMOIN: sans -U, la cle privee de l\'AC sur le disque signe', async () => {
    const pc = await linux();
    await pc.executeCommand('ssh-keygen -q -s ~/ca -I bob-key -n bob ~/id.pub');
    expect(await pc.executeCommand('ssh-keygen -L -f ~/id-cert.pub')).toContain('Key ID: "bob-key"');
  }, 60_000);

  it('l\'agent signe : la cle privee de l\'AC peut avoir disparu du disque', async () => {
    const pc = await linux();
    const out = await pc.executeCommand(
      'eval $(ssh-agent -s) > /dev/null; ssh-add ~/ca; rm ~/ca; ssh-keygen -s ~/ca.pub -U -I bob-key -n bob -z 9 ~/id.pub; ssh-keygen -L -f ~/id-cert.pub',
    );
    expect(out).toMatch(/Signed user key \/home\/user\/id-cert\.pub: id "bob-key" serial 9 for bob valid forever/);
    expect(out).toContain('Type: ssh-ed25519-cert-v01@openssh.com user certificate');
    const fingerprint = (await pc.executeCommand('ssh-keygen -l -f ~/ca.pub')).split(/\s+/)[1];
    expect(out).toContain(`Signing CA: ED25519 ${fingerprint}`);
  }, 60_000);

  it('sans agent : « agent not present »', async () => {
    const pc = await linux();
    expect(await pc.executeCommand('ssh-keygen -s ~/ca.pub -U -I x -n bob ~/id.pub'))
      .toContain('Cannot use public key for CA signature: agent not present');
  }, 60_000);

  it('une cle absente de l\'agent est refusee avec son chemin', async () => {
    const pc = await linux();
    const out = await pc.executeCommand('eval $(ssh-agent -s) > /dev/null; ssh-add ~/id; ssh-keygen -s ~/ca.pub -U -I x -n bob ~/id.pub');
    expect(out).toContain('CA key /home/user/ca.pub not found in agent');
  }, 60_000);

  it('une cle publique d\'AC introuvable est refusee', async () => {
    const pc = await linux();
    const out = await pc.executeCommand('eval $(ssh-agent -s) > /dev/null; ssh-keygen -s ~/nope.pub -U -I x -n bob ~/id.pub');
    expect(out).toContain('Cannot load CA public key /home/user/nope.pub');
  }, 60_000);
});

describe('windows', () => {
  it('le service ssh-agent signe, sans cle privee d\'AC sur le disque', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.powerOn();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc config ssh-agent start= demand');
    await pc.executeCommand('net start ssh-agent');
    await pc.executeCommand('ssh-keygen -q -t ed25519 -N "" -C ca@lab -f C:\\ca');
    await pc.executeCommand('ssh-keygen -q -t ed25519 -N "" -C bob@lab -f C:\\id');
    await pc.executeCommand('ssh-add C:\\ca');
    await pc.executeCommand('del C:\\ca');
    const signed = await pc.executeCommand('ssh-keygen -s C:\\ca.pub -U -I bob-key -n bob -z 4 C:\\id.pub');
    expect(signed).toMatch(/Signed user key C:\\id-cert\.pub: id "bob-key" serial 4 for bob valid forever/);
    expect(await pc.executeCommand('ssh-keygen -L -f C:\\id-cert.pub')).toContain('Signing CA: ED25519 SHA256:');
  }, 60_000);
});
