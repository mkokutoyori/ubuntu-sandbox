/**
 * Mesure de depart (suite du rapport « sSH alice@192.168.10.3 ») : `ssh` lance par
 * `executeCommand` sur un PC Windows tentait la connexion sur le fil SANS mot de passe puis, si
 * le serveur la refusait, retombait sur un client en memoire qui acceptait quand meme (« la
 * convention du simulateur ») : banniere, lignes vides, « Connection to ... closed. », sans
 * jamais interroger le serveur. Une cle valide n'etait de toute facon jamais cherchee toute
 * seule : ni les identites par defaut du dossier .ssh, ni l'agent.
 *
 * Le client en memoire est supprime ; `openWireSshConnection` offre desormais, comme OpenSSH, les
 * cles de l'agent puis les identites par defaut du compte local (`defaultIdentityFilesFor`), et
 * `-o PubkeyAuthentication=no` est honore. Laboratoire : PC Windows (WIN1) et serveur Linux dont
 * le compte alice n'a de mot de passe connu de personne. Sur les six cas, quatre tombent avant
 * la correction : cle par defaut NON autorisee, cle d'agent NON autorisee, aucun justificatif,
 * `PubkeyAuthentication=no` malgre une cle autorisee (la convention les acceptait tous). Deux
 * passent dans les deux etats et sont les TEMOINS : la cle par defaut autorisee et la cle
 * d'agent autorisee dont le fichier a ete supprime, qui prouvent que le laboratoire accepte
 * une vraie cle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const DENIED = 'alice@10.0.0.2: Permission denied (publickey,password).';
const NO_PROMPT = '-o StrictHostKeyChecking=no';

async function lab(): Promise<{ win: WindowsPC; srv: LinuxServer }> {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  [win, srv].forEach((d, i) => {
    d.powerOn();
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  const mask = new SubnetMask('255.255.255.0');
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:unknown-to-everyone" | sudo chpasswd');
  return { win, srv };
}

async function authorize(srv: LinuxServer, publicKey: string): Promise<void> {
  await srv.executeCommand('sudo mkdir -p /home/alice/.ssh');
  await srv.executeCommand(`echo "${publicKey}" | sudo tee /home/alice/.ssh/authorized_keys`);
  await srv.executeCommand('sudo chown -R alice:alice /home/alice/.ssh');
  await srv.executeCommand('sudo chmod 600 /home/alice/.ssh/authorized_keys');
}

async function startAgent(win: WindowsPC): Promise<void> {
  win.setCurrentUser('Administrator');
  await win.executeCommand('sc config ssh-agent start= demand');
  await win.executeCommand('net start ssh-agent');
  win.setCurrentUser('User');
}

async function defaultKey(win: WindowsPC): Promise<string> {
  await win.executeCommand('mkdir C:\\Users\\User\\.ssh');
  await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\Users\\User\\.ssh\\id_ed25519');
  return (await win.executeCommand('type C:\\Users\\User\\.ssh\\id_ed25519.pub')).trim();
}

describe('ssh non interactif depuis Windows : identites par defaut et agent, sans repli en memoire', () => {
  it('aucun justificatif : la session est refusee', async () => {
    const { win } = await lab();
    expect(await win.executeCommand(`ssh ${NO_PROMPT} alice@10.0.0.2 hostname`)).toContain(DENIED);
  });

  it('une cle par defaut que le serveur n\'autorise pas : refusee', async () => {
    const { win } = await lab();
    await defaultKey(win);
    expect(await win.executeCommand(`ssh ${NO_PROMPT} alice@10.0.0.2 hostname`)).toContain(DENIED);
  });

  it('temoin : la cle par defaut autorisee ouvre la session sans mot de passe', async () => {
    const { win, srv } = await lab();
    await authorize(srv, await defaultKey(win));
    const out = await win.executeCommand(`ssh ${NO_PROMPT} alice@10.0.0.2 hostname`);
    expect(out.trim()).toBe(srv.getHostname());
  });

  it('-o PubkeyAuthentication=no n\'offre pas la cle par defaut autorisee', async () => {
    const { win, srv } = await lab();
    await authorize(srv, await defaultKey(win));
    const out = await win.executeCommand(
      `ssh ${NO_PROMPT} -o PubkeyAuthentication=no alice@10.0.0.2 hostname`);
    expect(out).toContain(DENIED);
  });

  it('une cle de l\'agent que le serveur n\'autorise pas : refusee', async () => {
    const { win } = await lab();
    await startAgent(win);
    await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\agent');
    await win.executeCommand('ssh-add C:\\agent');
    await win.executeCommand('del C:\\agent');
    expect(await win.executeCommand(`ssh ${NO_PROMPT} alice@10.0.0.2 hostname`)).toContain(DENIED);
  });

  it('temoin : la cle de l\'agent autorisee ouvre la session, fichier supprime', async () => {
    const { win, srv } = await lab();
    await startAgent(win);
    await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\agent');
    await authorize(srv, (await win.executeCommand('type C:\\agent.pub')).trim());
    await win.executeCommand('ssh-add C:\\agent');
    await win.executeCommand('del C:\\agent');
    const out = await win.executeCommand(`ssh ${NO_PROMPT} alice@10.0.0.2 hostname`);
    expect(out.trim()).toBe(srv.getHostname());
  });
});
