/*
 * Le tutoriel « SSH de zero a heros » (docs/tutoriel-ssh-zero-a-heros.md), rejoue travaux pratiques
 * par travaux pratiques sur le laboratoire de dix equipements du tutoriel : poste et serveur Linux,
 * poste et serveur Windows, routeur et commutateur Cisco, routeur et commutateur Huawei, pare-feu
 * ASA, pare-feu FortiGate. La matrice « chaque equipement ouvre une session vers chacun des neuf
 * autres » est le TP 4 et vit dans tuto-ssh-matrice-equipements.test.ts (90 couples).
 *
 * Chaque describe est un TP ; les commandes sont celles que le tutoriel fait taper.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { buildMatrixLab, ADMIN, SECRET, Console, type Kind, type MatrixLab, type Node } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

let lab: MatrixLab;
const node = (kind: string): Node => lab.nodes.find((n) => n.kind === kind)!;
const cli = (kind: string): Cli => node(kind).device as unknown as Cli;
const ip = (kind: string): string => node(kind).ip;

const BY_PASSWORD = (user: string, secret: string, address: string, command: string) =>
  `sshpass -p ${secret} ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 ${user}@${address} "${command}"`;
const asAdmin = (kind: string, command: string) => BY_PASSWORD(ADMIN, SECRET, ip(kind), command);

const freshLab = async (): Promise<void> => { lab = await buildMatrixLab(); };

describe('TP 1 — le laboratoire respire', () => {
  beforeAll(freshLab, 120000);
  it('le poste Linux atteint les neuf autres equipements', async () => {
    for (const other of lab.nodes.filter((n) => n.kind !== 'linux-pc')) {
      const out = await cli('linux-pc').executeCommand(`ping -c 1 -W 1 ${other.ip}`);
      expect(out, other.kind).toContain('1 received');
    }
  });
});

describe('TP 2 — qui ecoute sur le port 22 ?', () => {
  beforeAll(freshLab, 120000);
  it('Linux : sshd ecoute et systemd le declare actif', async () => {
    expect(await cli('linux-server').executeCommand('ss -tlnp | grep :22')).toContain('sshd');
    expect(await cli('linux-server').executeCommand('systemctl is-active ssh')).toContain('active');
  });

  it('Windows : le service sshd tourne et le port 22 est en ecoute', async () => {
    expect(await cli('windows-server').executeCommand('sc query sshd')).toContain('RUNNING');
    expect(await cli('windows-server').executeCommand('netstat -an | findstr :22')).toContain('LISTENING');
  });

  it('IOS : `show ip ssh` annonce la version 2', async () => {
    expect(await cli('router-cisco').executeCommand('show ip ssh')).toContain('SSH Enabled - version 2.0');
  });

  it('VRP : `display ssh server status` annonce stelnet actif', async () => {
    const out = await cli('router-huawei').executeCommand('display ssh server status');
    expect(out).toContain('SSH version                     : 2.0');
    expect(out).toContain('Stelnet server                  : Enable');
  });

  it('ASA : la configuration porte la regle `ssh` du LAN', async () => {
    expect(await cli('firewall-cisco').executeCommand('show running-config | include ssh'))
      .toContain('ssh 10.0.0.0 255.255.255.0 inside');
  });

  it('FortiGate : `ssh` figure dans `allowaccess` de l\'interface', async () => {
    expect(await cli('firewall-fortinet').executeCommand('show system interface port1'))
      .toContain('set allowaccess ping ssh');
  });

  it('nmap voit le port 22 ouvert sur chaque equipement', async () => {
    for (const other of lab.nodes.filter((n) => n.kind !== 'linux-pc')) {
      expect(await cli('linux-pc').executeCommand(`nmap -Pn -p 22 ${other.ip}`), other.kind).toContain('22/tcp open');
    }
  });
});

describe('TP 3 — lire la banniere d\'identification', () => {
  beforeAll(freshLab, 120000);
  const banner = async (kind: string) =>
    (await cli('linux-pc').executeCommand(`ssh-keyscan ${ip(kind)}`)).split('\n').find((l) => l.includes('SSH-')) ?? '';

  it('chaque plateforme se reconnait a sa banniere', async () => {
    expect(await banner('linux-server')).toContain('SSH-2.0-OpenSSH_8.9p1 Ubuntu');
    expect(await banner('windows-server')).toContain('SSH-2.0-OpenSSH_for_Windows');
    expect(await banner('router-cisco')).toContain('SSH-2.0-Cisco-1.25');
    expect(await banner('router-huawei')).toContain('SSH-2.0-HUAWEI-1.5');
    expect(await banner('firewall-cisco')).toContain('Cisco-1.25');
  });
});

const clientSession = async (kind: string, command: string, secret: string, user: string): Promise<Console> => {
  const session = await Console.open(node(kind).device);
  await session.login(command, secret, user);
  return session;
};

describe('TP 5 — verifier l\'empreinte de la cle d\'hote avant de repondre « yes »', () => {
  beforeAll(freshLab, 120000);
  it('l\'empreinte annoncee a la premiere connexion est celle que le serveur calcule lui-meme', async () => {
    const server = await cli('linux-server').executeCommand('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    const expected = server.split(/\s+/)[1];
    const session = await Console.open(node('linux-pc').device);
    await session.type(`ssh ${ADMIN}@${ip('linux-server')}`);
    expect(session.promptText).toContain('Are you sure you want to continue connecting');
    expect(session.transcript).toContain(`ED25519 key fingerprint is ${expected}.`);
    await session.type('no');
    expect(session.transcript).toContain('Host key verification failed.');
  });
});

describe('TP 6 — une cle d\'hote qui change est une alerte, pas un detail', () => {
  beforeAll(freshLab, 120000);
  it('apres changement, le client refuse, et `ssh-keygen -R` puis une nouvelle verification rouvrent la porte', async () => {
    const pc = cli('linux-pc');
    expect(await pc.executeCommand(`sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=accept-new ${ADMIN}@${ip('linux-server')} hostname`)).toContain('lsrv');
    await cli('linux-server').executeCommand('sudo rm /etc/ssh/ssh_host_*');
    await cli('linux-server').executeCommand('sudo ssh-keygen -A');
    await cli('linux-server').executeCommand('sudo systemctl restart ssh');
    const refused = await pc.executeCommand(`sshpass -p ${SECRET} ssh ${ADMIN}@${ip('linux-server')} hostname`);
    expect(refused).toContain('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!');
    expect(refused).toContain(`ssh-keygen -f "/home/user/.ssh/known_hosts" -R "${ip('linux-server')}"`);
    await pc.executeCommand(`ssh-keygen -f /home/user/.ssh/known_hosts -R ${ip('linux-server')}`);
    expect(await pc.executeCommand(`sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=accept-new ${ADMIN}@${ip('linux-server')} hostname`)).toContain('lsrv');
  });
});

describe('TP 7 — l\'authentification par cle, de bout en bout', () => {
  beforeAll(freshLab, 120000);
  beforeAll(async () => {
    const pc = cli('linux-pc');
    await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');
    await pc.executeCommand('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa');
  }, 60000);

  it('Linux : ssh-copy-id installe la cle, puis la connexion se fait sans mot de passe', async () => {
    const pc = cli('linux-pc');
    expect(await pc.executeCommand(`ssh-copy-id -i ~/.ssh/id_ed25519.pub ${ADMIN}@${ip('linux-server')}`, `${SECRET}\n`)).toContain('Number of key(s) added: 1');
    expect(await pc.executeCommand(`ssh -o PasswordAuthentication=no ${ADMIN}@${ip('linux-server')} hostname`)).toContain('lsrv');
    expect(await cli('linux-server').executeCommand('sudo grep "Accepted publickey" /var/log/auth.log'))
      .toContain(`Accepted publickey for ${ADMIN} from ${ip('linux-pc')}`);
  });

  it('Linux : `PasswordAuthentication no` ferme la porte aux mots de passe et laisse celle des cles', async () => {
    const server = cli('linux-server');
    await server.executeCommand('echo "PasswordAuthentication no" | sudo tee -a /etc/ssh/sshd_config');
    await server.executeCommand('sudo systemctl restart ssh');
    expect(await cli('linux-pc').executeCommand(
      `sshpass -p ${SECRET} ssh -o PubkeyAuthentication=no ${ADMIN}@${ip('linux-server')} hostname`)).toMatch(/Permission denied/);
    expect(await cli('linux-pc').executeCommand(
      `ssh -o PasswordAuthentication=no ${ADMIN}@${ip('linux-server')} hostname`)).toContain('lsrv');
  });

  it('VRP : la cle RSA du poste est declaree en cle de pair puis attribuee au compte', async () => {
    const pub = (await cli('linux-pc').executeCommand('cat ~/.ssh/id_rsa.pub')).trim();
    const vrp = cli('router-huawei');
    for (const line of [
      'system-view', 'rsa peer-public-key lpc encoding-type openssh', 'public-key-code begin', pub,
      'public-key-code end', 'peer-public-key end',
      `ssh user ${ADMIN} authentication-type rsa`, `ssh user ${ADMIN} assign rsa-key lpc`, 'return',
    ]) await vrp.executeCommand(line);
    expect(await cli('linux-pc').executeCommand(
      `ssh -i ~/.ssh/id_rsa -o PreferredAuthentications=publickey -o StrictHostKeyChecking=no ${ADMIN}@${ip('router-huawei')} "display clock"`))
      .toContain('Time Zone');
  });

  it('IOS : `ip ssh pubkey-chain` range le hachage de la cle sous le compte, sans jamais l\'afficher', async () => {
    const body = (await cli('linux-pc').executeCommand('cat ~/.ssh/id_rsa.pub')).trim().split(/\s+/)[1];
    const ios = cli('router-cisco');
    for (const line of ['enable', 'configure terminal', 'ip ssh pubkey-chain', `username ${ADMIN}`, 'key-string',
      ...(body.match(/.{1,64}/g) ?? []), 'exit', 'exit', 'exit', 'end']) await ios.executeCommand(line);
    expect(await ios.executeCommand('show running-config | begin pubkey')).toMatch(/key-hash ssh-rsa [0-9A-F]{32}/);
    expect(await cli('linux-pc').executeCommand(
      `ssh -i ~/.ssh/id_rsa -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o StrictHostKeyChecking=no ${ADMIN}@${ip('router-cisco')} "show clock"`))
      .toMatch(/\d\d:\d\d:\d\d/);
  });

  it('FortiGate : la cle est un attribut de l\'administrateur', async () => {
    const pub = (await cli('linux-pc').executeCommand('cat ~/.ssh/id_ed25519.pub')).trim();
    const fgt = cli('firewall-fortinet');
    for (const line of ['config system admin', `edit ${ADMIN}`, `set ssh-public-key1 "${pub}"`, 'next', 'end']) {
      await fgt.executeCommand(line);
    }
    expect(await cli('linux-pc').executeCommand(
      `ssh -o PasswordAuthentication=no -o StrictHostKeyChecking=no ${ADMIN}@${ip('firewall-fortinet')} "get system status"`))
      .toContain('Version: FortiGate');
  });
});


describe('TP 8 — qui a le droit de se connecter ?', () => {
  beforeAll(freshLab, 120000);
  const trySsh = (from: 'linux-pc' | 'linux-server', to: string, command: string, secret = SECRET, user = ADMIN) =>
    cli(from).executeCommand(BY_PASSWORD(user, secret, ip(to), command));

  it('Cisco IOS : `access-class` sur la ligne vty ne laisse entrer que le poste autorise', async () => {
    const ios = cli('router-cisco');
    for (const line of ['enable', 'configure terminal', 'ip access-list standard VTY-IN', `permit ${ip('linux-pc')}`, 'exit',
      'line vty 0 4', 'access-class VTY-IN in', 'end']) await ios.executeCommand(line);
    expect(await trySsh('linux-pc', 'router-cisco', 'show clock')).toContain('UTC');
    expect(await trySsh('linux-server', 'router-cisco', 'show clock')).toContain('Connection refused');
    for (const line of ['configure terminal', 'line vty 0 4', 'no access-class VTY-IN in', 'end']) await ios.executeCommand(line);
    expect(await trySsh('linux-server', 'router-cisco', 'show clock')).toContain('UTC');
  });

  it('Huawei VRP : `acl` sous `user-interface vty` fait de meme', async () => {
    const vrp = cli('router-huawei');
    for (const line of ['system-view', 'acl 2000', `rule 5 permit source ${ip('linux-pc')} 0`, 'rule 10 deny', 'quit',
      'user-interface vty 0 4', 'acl 2000 inbound', 'return']) await vrp.executeCommand(line);
    expect(await trySsh('linux-pc', 'router-huawei', 'display clock')).toContain('Time Zone');
    expect(await trySsh('linux-server', 'router-huawei', 'display clock')).toContain('Connection refused');
    for (const line of ['system-view', 'user-interface vty 0 4', 'undo acl inbound', 'return']) await vrp.executeCommand(line);
  });

  it('Cisco ASA : `ssh <reseau> <masque> <interface>` ecarte les autres sans repondre', async () => {
    const asa = cli('firewall-cisco');
    for (const line of ['configure terminal', 'no ssh 10.0.0.0 255.255.255.0 inside', `ssh ${ip('linux-pc')} 255.255.255.255 inside`, 'end']) {
      await asa.executeCommand(line);
    }
    expect(await trySsh('linux-pc', 'firewall-cisco', 'show version | include Version')).toContain('Adaptive Security');
    expect(await trySsh('linux-server', 'firewall-cisco', 'show version')).toContain('Connection timed out');
    for (const line of ['configure terminal', `no ssh ${ip('linux-pc')} 255.255.255.255 inside`, 'ssh 10.0.0.0 255.255.255.0 inside', 'end']) {
      await asa.executeCommand(line);
    }
  });

  it('FortiGate : `trusthost` restreint le compte, `allowaccess` restreint l\'interface', async () => {
    const fgt = cli('firewall-fortinet');
    for (const line of ['config system admin', `edit ${ADMIN}`, `set trusthost1 ${ip('linux-pc')} 255.255.255.255`, 'next', 'end']) {
      await fgt.executeCommand(line);
    }
    expect(await trySsh('linux-pc', 'firewall-fortinet', 'get system status')).toContain('Version: FortiGate');
    expect(await trySsh('linux-server', 'firewall-fortinet', 'get system status')).toContain('Permission denied');
    for (const line of ['config system admin', `edit ${ADMIN}`, 'unset trusthost1', 'next', 'end',
      'config system interface', 'edit "port1"', 'set allowaccess ping', 'next', 'end']) await fgt.executeCommand(line);
    expect(await trySsh('linux-pc', 'firewall-fortinet', 'get system status')).toContain('Connection timed out');
    for (const line of ['config system interface', 'edit "port1"', 'set allowaccess ping ssh', 'next', 'end']) await fgt.executeCommand(line);
    expect(await trySsh('linux-pc', 'firewall-fortinet', 'get system status')).toContain('Version: FortiGate');
  });

  it('Linux : `AllowUsers` n\'admet que les comptes nommes, et le journal dit pourquoi', async () => {
    const server = cli('linux-server');
    await server.executeCommand('echo "AllowUsers alice" | sudo tee -a /etc/ssh/sshd_config');
    await server.executeCommand('sudo systemctl restart ssh');
    expect(await trySsh('linux-pc', 'linux-server', 'hostname')).toMatch(/Permission denied/);
    expect(await server.executeCommand('sudo grep "not allowed" /var/log/auth.log'))
      .toContain(`User ${ADMIN} from ${ip('linux-pc')} not allowed because not listed in AllowUsers`);
    await server.executeCommand("sudo sed -i '/AllowUsers/d' /etc/ssh/sshd_config");
    await server.executeCommand('sudo systemctl restart ssh');
  });
});

describe('TP 9 — fermer les sessions oubliees', () => {
  beforeAll(freshLab, 120000);
  const idleAfter = async (kind: Kind, configure: string[], silenceSeconds: number): Promise<string> => {
    const clock = installSimulationClock(new SimulationClock({
      startPump: () => () => undefined, originMs: Date.UTC(2026, 9, 8, 9, 0, 0),
    }));
    const fresh = await buildMatrixLab(['linux-pc', kind]);
    const [from, target] = fresh.nodes;
    const device = target.device as unknown as Cli;
    for (const line of configure) await device.executeCommand(line);
    const session = await Console.open(from.device);
    await session.login(`ssh ${ADMIN}@${target.ip}`, SECRET, ADMIN);
    await clock.advance(silenceSeconds * 1000);
    await session.type(kind.endsWith('huawei') ? 'display clock' : kind === 'firewall-fortinet' ? 'get system status' : 'show clock');
    return session.prompt;
  };

  afterEach(() => { __resetSimulationClock(); });

  it('IOS : `exec-timeout 1 0` ferme la session silencieuse', async () => {
    expect(await idleAfter('router-cisco', ['configure terminal', 'line vty 0 4', 'exec-timeout 1 0', 'end'], 90)).toMatch(/lpc/);
  }, 30000);

  it('VRP : `idle-timeout 1 0` sous `user-interface vty` fait de meme', async () => {
    expect(await idleAfter('router-huawei', ['system-view', 'user-interface vty 0 4', 'idle-timeout 1 0', 'quit', 'return'], 90)).toMatch(/lpc/);
  }, 30000);

  it('ASA : `ssh timeout 1` borne les sessions d\'administration', async () => {
    expect(await idleAfter('firewall-cisco', ['configure terminal', 'ssh timeout 1', 'end'], 90)).toMatch(/lpc/);
  }, 30000);

  it('FortiGate : `set admintimeout 1` fait de meme', async () => {
    expect(await idleAfter('firewall-fortinet', ['config system global', 'set admintimeout 1', 'end'], 90)).toMatch(/lpc/);
  }, 30000);

  it('temoin : avec dix minutes, la session survit a 90 secondes de silence', async () => {
    expect(await idleAfter('router-cisco', ['configure terminal', 'line vty 0 4', 'exec-timeout 10 0', 'end'], 90)).not.toMatch(/lpc/);
  }, 30000);
});

describe('TP 10 — freiner les tentatives', () => {
  beforeAll(freshLab, 120000);
  it('Cisco IOS : `login block-for` ferme la porte apres trop d\'echecs, meme au bon mot de passe', async () => {
    const fresh = await buildMatrixLab(['linux-pc', 'router-cisco']);
    const [from, target] = fresh.nodes;
    const ios = target.device as unknown as Cli;
    for (const line of ['enable', 'configure terminal', 'login block-for 60 attempts 2 within 30', 'end']) await ios.executeCommand(line);
    const attempt = (secret: string) => (from.device as unknown as Cli).executeCommand(BY_PASSWORD(ADMIN, secret, target.ip, 'show clock'));
    expect(await attempt('wrong')).toContain('Permission denied');
    expect(await attempt('wrong')).toContain('Permission denied');
    expect(await attempt(SECRET)).toContain('Quiet-Mode');
    expect(await ios.executeCommand('show login')).toContain('Router presently in Quiet-Mode.');
  });

  it('Linux : chaque echec laisse une ligne « Failed password » dans auth.log', async () => {
    const server = cli('linux-server');
    const before = (await server.executeCommand('sudo grep -c "Failed password" /var/log/auth.log')).trim();
    for (let i = 0; i < 3; i++) await cli('linux-pc').executeCommand(BY_PASSWORD(ADMIN, 'wrong', ip('linux-server'), 'hostname'));
    const after = (await server.executeCommand('sudo grep -c "Failed password" /var/log/auth.log')).trim();
    expect(Number(after) - Number(before)).toBeGreaterThanOrEqual(3);
  });

  it('FortiGate : le verrouillage d\'administrateur coupe les tentatives, puis se leve', async () => {
    const clock = installSimulationClock(new SimulationClock({
      startPump: () => () => undefined, originMs: Date.UTC(2026, 9, 8, 9, 0, 0),
    }));
    try {
      const fresh = await buildMatrixLab(['linux-pc', 'firewall-fortinet']);
      const [from, target] = fresh.nodes;
      const attempt = (secret: string) => (from.device as unknown as Cli).executeCommand(BY_PASSWORD(ADMIN, secret, target.ip, 'get system status'));
      for (let i = 0; i < 3; i++) await attempt('wrong');
      expect(await attempt(SECRET)).toContain('Permission denied');
      await clock.advance(120_000);
      expect(await attempt(SECRET)).toContain('Version: FortiGate');
    } finally {
      __resetSimulationClock();
    }
  });
});

describe('TP 11 — afficher une banniere d\'avertissement', () => {
  beforeAll(freshLab, 120000);
  const bannerSeenFrom = async (kind: string): Promise<string> => {
    const session = await Console.open(node('linux-pc').device);
    await session.login(`ssh ${ADMIN}@${ip(kind)}`, SECRET, ADMIN);
    return session.transcript;
  };

  it('Linux : `Banner /etc/issue.net` precede la demande de mot de passe', async () => {
    const server = cli('linux-server');
    await server.executeCommand("echo 'Acces reserve au personnel autorise' | sudo tee /etc/issue.net");
    await server.executeCommand("echo 'Banner /etc/issue.net' | sudo tee -a /etc/ssh/sshd_config");
    await server.executeCommand('sudo systemctl restart ssh');
    const seen = await bannerSeenFrom('linux-server');
    expect(seen).toContain('Acces reserve au personnel autorise');
    expect(seen.indexOf('Acces reserve')).toBeLessThan(seen.indexOf("password:"));
  });

  it('IOS : `banner motd` s\'affiche a l\'ouverture de la session', async () => {
    for (const line of ['enable', 'configure terminal', 'banner motd ^CEquipement sous surveillance^C', 'end']) await cli('router-cisco').executeCommand(line);
    expect(await bannerSeenFrom('router-cisco')).toContain('Equipement sous surveillance');
  });

  it('VRP : `header login information` s\'affiche avant le mot de passe', async () => {
    for (const line of ['system-view', 'header login information "Acces journalise"', 'return']) await cli('router-huawei').executeCommand(line);
    expect(await bannerSeenFrom('router-huawei')).toContain('Acces journalise');
  });

  it('temoin : sans banniere configuree, le serveur Windows n\'affiche rien avant le mot de passe', async () => {
    const seen = await bannerSeenFrom('windows-server');
    expect(seen).not.toContain('Acces reserve');
    expect(seen).not.toContain('Acces journalise');
  });
});

describe('TP 12 — transferer des fichiers : scp et sftp', () => {
  beforeAll(freshLab, 120000);
  it('Linux vers Linux : scp envoie puis recupere un fichier', async () => {
    const pc = cli('linux-pc');
    await pc.executeCommand('echo "contenu-du-tp12" > /tmp/tp12.txt');
    const sent = await pc.executeCommand(`sshpass -p ${SECRET} scp -o StrictHostKeyChecking=no /tmp/tp12.txt ${ADMIN}@${ip('linux-server')}:/tmp/tp12.txt`);
    expect(sent).toContain('100%');
    expect(await cli('linux-server').executeCommand('cat /tmp/tp12.txt')).toContain('contenu-du-tp12');
    await pc.executeCommand(`sshpass -p ${SECRET} scp -o StrictHostKeyChecking=no ${ADMIN}@${ip('linux-server')}:/tmp/tp12.txt /tmp/retour.txt`);
    expect(await pc.executeCommand('cat /tmp/retour.txt')).toContain('contenu-du-tp12');
  });

  it('Linux vers Windows : le fichier arrive dans le profil de l\'utilisateur', async () => {
    const pc = cli('linux-pc');
    await pc.executeCommand('echo "vers-windows" > /tmp/tp12w.txt');
    const sent = await pc.executeCommand(`sshpass -p user scp -o StrictHostKeyChecking=no /tmp/tp12w.txt User@${ip('windows-pc')}:C:/Users/User/tp12w.txt`);
    expect(sent).toContain('100%');
    expect(await cli('windows-pc').executeCommand('type C:\\Users\\User\\tp12w.txt')).toContain('vers-windows');
  });

  it('IOS : `ip scp server enable` ouvre flash: en lecture et en ecriture', async () => {
    const ios = cli('router-cisco');
    for (const line of ['enable', 'configure terminal', 'ip scp server enable', 'end']) await ios.executeCommand(line);
    const pc = cli('linux-pc');
    await pc.executeCommand('echo "depuis-le-poste" > /tmp/Lab12.txt');
    const scp = (args: string) => pc.executeCommand(`sshpass -p ${SECRET} scp -O -o StrictHostKeyChecking=no ${args}`);
    expect(await scp(`/tmp/Lab12.txt ${ADMIN}@${ip('router-cisco')}:flash:Lab12.txt`)).toContain('100%');
    expect(await ios.executeCommand('dir flash:')).toContain('Lab12.txt');
    await scp(`${ADMIN}@${ip('router-cisco')}:flash:Lab12.txt /tmp/retour12.txt`);
    expect(await pc.executeCommand('cat /tmp/retour12.txt')).toContain('depuis-le-poste');
  });

  it('VRP : sftp est refuse tant que `sftp server enable` n\'est pas tape, puis ouvert', async () => {
    const open = () => cli('linux-pc').executeCommand(`sshpass -p ${SECRET} sftp -o StrictHostKeyChecking=no ${ADMIN}@${ip('router-huawei')} <<< 'pwd'`);
    expect(await open()).toContain('subsystem request failed');
    for (const line of ['system-view', 'sftp server enable', `ssh user ${ADMIN} service-type all`, 'return']) await cli('router-huawei').executeCommand(line);
    expect(await open()).not.toContain('subsystem request failed');
  });
});

describe('TP 13 — rebondir d\'un equipement a l\'autre : ProxyJump', () => {
  beforeAll(freshLab, 120000);
  it('Linux traverse le serveur pour atteindre le routeur Cisco', async () => {
    const out = await cli('linux-pc').executeCommand(
      `sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=no -J ${ADMIN}@${ip('linux-server')} ${ADMIN}@${ip('router-cisco')} 'show clock'`);
    expect(out).toMatch(/\d\d:\d\d:\d\d/);
  });

  it('le meme saut atteint le FortiGate', async () => {
    const out = await cli('linux-pc').executeCommand(
      `sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=no -J ${ADMIN}@${ip('linux-server')} ${ADMIN}@${ip('firewall-fortinet')} 'get system status'`);
    expect(out).toContain('Version: FortiGate');
  });

  it('temoin : un rebond vers une adresse sans service echoue', async () => {
    const out = await cli('linux-pc').executeCommand(
      `sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -J ${ADMIN}@${ip('linux-server')} ${ADMIN}@10.0.0.99 'hostname'`);
    expect(out).not.toContain('lsrv');
    expect(out).toMatch(/refused|timed out|No route|Could not|closed/i);
  }, 30000);
});

describe('TP 14 — retrouver la trace d\'une connexion', () => {
  beforeAll(freshLab, 120000);
  const fromPc = (kind: string, secret = SECRET, user = ADMIN) =>
    cli('linux-pc').executeCommand(BY_PASSWORD(user, secret, ip(kind), 'hostname'));

  it('Linux : auth.log garde « Accepted password » avec l\'adresse source', async () => {
    await fromPc('linux-server');
    const trace = await cli('linux-server').executeCommand('sudo grep "Accepted password" /var/log/auth.log');
    expect(trace).toContain(`Accepted password for ${ADMIN} from ${ip('linux-pc')}`);
  });

  it('IOS : `login on-success log` fait ecrire %SEC_LOGIN-5-LOGIN_SUCCESS, la session SSH2 est toujours tracee', async () => {
    const fresh = await buildMatrixLab(['linux-pc', 'router-cisco']);
    const [from, target] = fresh.nodes;
    const ios = target.device as unknown as Cli;
    for (const line of ['enable', 'configure terminal', 'login on-success log', 'login on-failure log', 'logging buffered 8192', 'end']) await ios.executeCommand(line);
    const attempt = (secret: string) => (from.device as unknown as Cli).executeCommand(BY_PASSWORD(ADMIN, secret, target.ip, 'show clock'));
    await attempt(SECRET);
    await attempt('wrong');
    const journal = await ios.executeCommand('show logging');
    expect(journal).toContain('%SSH-5-SSH2_SESSION');
    expect(journal).toContain(`%SEC_LOGIN-5-LOGIN_SUCCESS: Login Success [user: ${ADMIN}] [Source: ${from.ip}]`);
    expect(journal).toContain('%SEC_LOGIN-4-LOGIN_FAILED');
  });

  it('FortiGate : le journal d\'evenements nomme l\'administrateur et l\'origine', async () => {
    await fromPc('firewall-fortinet');
    await fromPc('firewall-fortinet', 'wrong');
    const forti = cli('firewall-fortinet');
    await forti.executeCommand('execute log filter category 1');
    const journal = await forti.executeCommand('execute log display');
    expect(journal).toContain('logdesc="Admin login successful"');
    expect(journal).toContain(`ui="ssh(${ip('linux-pc')})"`);
    expect(journal).toContain('logdesc="Admin login failed"');
  });

  it('Windows : le journal Securite porte les evenements 4624 et 4625', async () => {
    await fromPc('windows-server');
    await fromPc('windows-server', 'wrong');
    const events = await cli('windows-server').executeCommand('wevtutil qe Security /c:50 /rd:true /f:text');
    expect(events).toContain('Event ID: 4624');
    expect(events).toContain('Event ID: 4625');
  });
});

describe('TP 15 — auditer le parc depuis un seul poste', () => {
  beforeAll(freshLab, 120000);
  const SCRIPT = [
    '#!/bin/bash',
    'audit() { echo "== $1"; sshpass -p "$SSHPASS_VALUE" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 "netadmin@$2" "$3"; }',
    `SSHPASS_VALUE=${SECRET}`,
    `audit lsrv ${'$LSRV'} "ss -tln | grep :22"`,
    `audit ior ${'$IOR'} "show ip ssh"`,
    `audit vrr ${'$VRR'} "display ssh server status"`,
    `audit fgt ${'$FGT'} "show system interface port1"`,
  ].join('\n');

  it('un script bash interroge Linux, IOS, VRP et FortiGate et ramene un rapport unique', async () => {
    const pc = cli('linux-pc');
    const script = SCRIPT
      .replace('$LSRV', ip('linux-server')).replace('$IOR', ip('router-cisco'))
      .replace('$VRR', ip('router-huawei')).replace('$FGT', ip('firewall-fortinet'));
    await pc.executeCommand(`cat > /tmp/audit-ssh.sh <<'EOF'\n${script}\nEOF`);
    await pc.executeCommand('chmod +x /tmp/audit-ssh.sh');
    const report = await pc.executeCommand('/tmp/audit-ssh.sh');
    expect(report).toMatch(/== lsrv\s+LISTEN[^\n]*:22/);
    expect(report).toMatch(/== ior[\s\S]*SSH Enabled - version 2\.0/);
    expect(report).toMatch(/== vrr[\s\S]*Stelnet server\s+: Enable/);
    expect(report).toMatch(/== fgt[\s\S]*set allowaccess ping ssh/);
  });
});
