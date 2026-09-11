/**
 * `ssh-agent`, `ssh-add`, `ssh-copy-id`, `ssh-keyscan` — ecrits A L'AVEUGLE
 * depuis OpenSSH, avant toute lecture de l'implantation de ce depot.
 *
 * Sources, clonees pour ce lot (`github.com/openssh/openssh-portable`).
 * Les formats de sortie viennent du CODE, pas d'un souvenir :
 *
 *   ssh-agent.c  l. 2521  "%s=%s; export %s;\n"   (sh)   /  "setenv %s %s;\n" (csh)
 *   ssh-agent.c  l. 2525  "echo Agent pid %ld;\n"
 *   ssh-agent.c  l. 2411  "echo Agent pid %ld killed;\n"
 *   ssh-add.c    l. 377   "Identity added: %s (%s)\n"
 *   ssh-add.c    l. 234   "All identities removed.\n"
 *   ssh-add.c    l. 543   "The agent has no identities.\n"
 *   ssh-add.c    l. 551   "%u %s %s (%s)\n"        (-l : bits empreinte commentaire (TYPE))
 *   ssh-add.c    l. 560   "<cle publique> %s\n"    (-L)
 *   contrib/ssh-copy-id  l. 413-416 : le bloc « Number of key(s) added: N »
 *                        puis « Now try logging into the machine, with: "ssh …" »
 *                        puis « and check to make sure that only the key(s)
 *                        you wanted were added. »
 *   ssh-keyscan.c l. 330 : une ligne « <hote> <type> <cle> » par cle trouvee.
 *
 * `ssh-copy-id` n'est PAS livre par Windows (c'est un script du repertoire
 * `contrib`), donc il n'est eprouve que sur Linux. Les trois autres le sont
 * sur les deux plateformes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const CLE = '/root/.ssh/id_ed25519';

async function poste(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${CLE}`);
  return pc;
}

async function labo(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const m = new SubnetMask('255.255.255.0');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), m);
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${CLE}`);
  return { pc, srv };
}

describe('ssh-agent : les lignes d environnement qu un shell EVALUE', () => {
  it('Linux : `-s` rend la forme Bourne, terminee par un point-virgule', async () => {
    const pc = await poste();
    const out = await pc.executeCommand('ssh-agent -s');
    expect(out).toMatch(/SSH_AUTH_SOCK=\S+; export SSH_AUTH_SOCK;/);
    expect(out).toMatch(/SSH_AGENT_PID=\d+; export SSH_AGENT_PID;/);
    expect(out).toMatch(/echo Agent pid \d+;/);
  });

  it('Linux : `-c` rend la forme C-shell', async () => {
    const pc = await poste();
    const out = await pc.executeCommand('ssh-agent -c');
    expect(out).toMatch(/setenv SSH_AUTH_SOCK \S+;/);
    expect(out).toMatch(/setenv SSH_AGENT_PID \d+;/);
  });

  it('Linux : `-k` annonce la mise a mort du pid', async () => {
    const pc = await poste();
    expect(await pc.executeCommand('ssh-agent -k')).toMatch(/echo Agent pid \d+ killed;/);
  });

  it('Windows : `ssh-agent -s` rend aussi la forme Bourne', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    pc.powerOn();
    const out = await pc.executeCommand('ssh-agent -s');
    expect(out).toMatch(/SSH_AUTH_SOCK=\S+; export SSH_AUTH_SOCK;/);
  });
});

describe('ssh-add : ce que l agent porte, et ce qu il en dit', () => {
  it('Linux : un agent vide le DIT', async () => {
    const pc = await poste();
    expect(await pc.executeCommand('ssh-add -l')).toContain('The agent has no identities.');
  });

  it('Linux : ajouter une identite l annonce avec son chemin et son commentaire', async () => {
    const pc = await poste();
    const out = await pc.executeCommand(`ssh-add ${CLE}`);
    expect(out).toMatch(new RegExp(`Identity added: ${CLE} \\(.+\\)`));
  });

  it('Linux : `-l` rend « bits empreinte commentaire (TYPE) »', async () => {
    const pc = await poste();
    await pc.executeCommand(`ssh-add ${CLE}`);
    const ligne = (await pc.executeCommand('ssh-add -l')).trim();
    expect(ligne).toMatch(/^256 SHA256:\S+ .+ \(ED25519\)$/m);
  });

  it('Linux : `-L` rend la cle PUBLIQUE, pas son empreinte', async () => {
    const pc = await poste();
    await pc.executeCommand(`ssh-add ${CLE}`);
    const out = await pc.executeCommand('ssh-add -L');
    const surDisque = (await pc.executeCommand(`cat ${CLE}.pub`)).trim().split(/\s+/)[1];
    expect(out).toContain('ssh-ed25519 ');
    expect(out).toContain(surDisque);
  });

  it('Linux : `-d` retire une identite, `-D` les retire toutes', async () => {
    const pc = await poste();
    await pc.executeCommand(`ssh-add ${CLE}`);
    expect(await pc.executeCommand(`ssh-add -d ${CLE}`)).toContain('Identity removed');
    await pc.executeCommand(`ssh-add ${CLE}`);
    expect(await pc.executeCommand('ssh-add -D')).toContain('All identities removed.');
    expect(await pc.executeCommand('ssh-add -l')).toContain('The agent has no identities.');
  });

  it('Windows : `ssh-add -l` sur un agent vide rend la MEME phrase', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    pc.powerOn();
    expect(await pc.executeCommand('ssh-add -l')).toContain('The agent has no identities.');
  });
});

describe('ssh-copy-id : la cle publique atterrit dans authorized_keys DU SERVEUR', () => {
  it('le bloc de sortie est celui du script contrib', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(
      `sshpass -p secret123 ssh-copy-id -o StrictHostKeyChecking=no -i ${CLE}.pub alice@10.0.0.2`);
    expect(out).toContain('Number of key(s) added: 1');
    expect(out).toContain('Now try logging into the machine, with:');
    expect(out).toContain('and check to make sure that only the key(s) you wanted were added.');
  });

  it('la cle est ECRITE chez alice, sur le serveur', async () => {
    const { pc, srv } = await labo();
    const publique = (await pc.executeCommand(`cat ${CLE}.pub`)).trim().split(/\s+/)[1];
    await pc.executeCommand(
      `sshpass -p secret123 ssh-copy-id -o StrictHostKeyChecking=no -i ${CLE}.pub alice@10.0.0.2`);
    const autorisees = await srv.executeCommand('sudo cat /home/alice/.ssh/authorized_keys');
    expect(autorisees).toContain(publique);
  });

  it('deux passages n ecrivent pas la cle DEUX fois', async () => {
    const { pc, srv } = await labo();
    const ligne = `sshpass -p secret123 ssh-copy-id -o StrictHostKeyChecking=no -i ${CLE}.pub alice@10.0.0.2`;
    await pc.executeCommand(ligne);
    const second = await pc.executeCommand(ligne);
    expect(second).toContain('Number of key(s) added: 0');
    const autorisees = await srv.executeCommand('sudo cat /home/alice/.ssh/authorized_keys');
    expect(autorisees.split('\n').filter(l => l.includes('ssh-ed25519')).length).toBe(1);
  });

  it('apres coup, la connexion par cle passe SANS mot de passe', async () => {
    const { pc } = await labo();
    await pc.executeCommand(
      `sshpass -p secret123 ssh-copy-id -o StrictHostKeyChecking=no -i ${CLE}.pub alice@10.0.0.2`);
    const out = await pc.executeCommand(
      `ssh -o StrictHostKeyChecking=no -i ${CLE} alice@10.0.0.2 whoami`);
    expect(out.trim()).toBe('alice');
  });
});

describe('ssh-keyscan : les cles d hote, prises SUR LE SERVEUR', () => {
  it('une ligne « hote type cle » par cle trouvee', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand('ssh-keyscan 10.0.0.2');
    const lignes = out.split('\n').filter(l => l.trim() !== '' && !l.startsWith('#'));
    expect(lignes.length).toBeGreaterThan(0);
    for (const ligne of lignes) {
      expect(ligne).toMatch(/^10\.0\.0\.2 (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) \S+$/);
    }
  });

  it('`-t ed25519` ne rend QUE ce type', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand('ssh-keyscan -t ed25519 10.0.0.2');
    const lignes = out.split('\n').filter(l => l.trim() !== '' && !l.startsWith('#'));
    expect(lignes.length).toBeGreaterThan(0);
    for (const ligne of lignes) expect(ligne).toContain('ssh-ed25519');
  });

  it('la cle annoncee est celle que known_hosts retient apres une vraie connexion', async () => {
    const { pc } = await labo();
    const balayee = (await pc.executeCommand('ssh-keyscan -t ed25519 10.0.0.2'))
      .split('\n').find(l => l.includes('ssh-ed25519'))?.split(/\s+/)[2];
    await pc.executeCommand('sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@10.0.0.2 true');
    const connus = await pc.executeCommand('cat /root/.ssh/known_hosts');
    expect(balayee).toBeTruthy();
    expect(connus).toContain(balayee!);
  });

  it('un hote injoignable ne rend AUCUNE ligne de cle', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand('ssh-keyscan 10.0.0.77');
    const lignes = out.split('\n').filter(l => l.trim() !== '' && !l.startsWith('#'));
    expect(lignes.length).toBe(0);
  });
});
