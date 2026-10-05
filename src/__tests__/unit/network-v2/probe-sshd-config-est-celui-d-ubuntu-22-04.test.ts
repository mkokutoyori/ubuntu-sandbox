/**
 * Sonde — le `sshd_config` d'une Ubuntu 22.04, ses `Include`, et « la premiere valeur gagne ».
 *
 * Mesure de depart (sur 11558b441) : `/etc/ssh/sshd_config` etait une liste plate ecrite par
 * `serializeSshdConfig` (`Port 22`, `PermitRootLogin prohibit-password`, `MaxAuthTries 6`,
 * `MaxStartups 10:30:100`, ... toutes actives, aucun commentaire) au lieu du fichier
 * d'OpenSSH 8.9p1 tel qu'Ubuntu l'installe (valeurs par defaut commentees, `Include
 * /etc/ssh/sshd_config.d/*.conf` en tete) ; `/etc/ssh/sshd_config.d/` n'existait pas ; `Include`
 * etait accepte puis ignore ; et la DERNIERE valeur d'un mot-cle gagnait, alors que
 * sshd_config(5) dit « For each keyword, the first obtained value will be used. »
 * (servconf.c : `if (*activep && *intptr == -1) *intptr = value;`). `UsePAM` absent valait
 * `yes`, alors que servconf.c le met a 0 (`if (options->use_pam == -1) options->use_pam = 0`).
 *
 * Le texte du fichier est celui d'une 22.04 fourni par l'utilisateur ; ses directives de
 * laboratoire (`Port 22`, `LogLevel DEBUG`, `PermitRootLogin yes`, `PubkeyAuthentication yes`,
 * `AuthorizedKeysFile`, `#Include`) sont rendues a leur valeur d'origine : celles d'un fichier
 * qu'Ubuntu n'a pas encore touche.
 *
 * Mesure avant correctif (la sonde rejouee avec les sources de 11558b441) : 10 cas sur 11
 * tombent. Le onzieme, « un bloc Match d'un fichier inclus ne captive pas les lignes
 * suivantes », passe a l'identique pour une raison STRUCTURELLE : avant, `Include` etait
 * ignore, donc aucun bloc inclus n'existait pour capturer quoi que ce soit ; il garde
 * l'expansion d'`Include` contre cette regression-la, pas contre un defaut de la base.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildLan, assignIps, PC2_IP, type SshLan } from './ssh-lan-fixtures';

let lan: SshLan;

beforeEach(async () => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  lan = buildLan();
  await assignIps(lan);
});

const server = () => lan.pc2;
const effective = async (): Promise<string> => server().executeCommand('sudo sshd -T');
const write = (path: string, text: string) => server().executeCommand(`printf '%s' '${text}' | sudo tee ${path} > /dev/null`);

describe('le fichier installe', () => {
  it('commence comme celui d\'Ubuntu 22.04 et finit par l\'exemple Match', async () => {
    const text = await server().executeCommand('cat /etc/ssh/sshd_config');
    expect(text.split('\n')[0]).toBe('# This is the sshd server system-wide configuration file.  See');
    expect(text).toContain('# This sshd was compiled with PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games');
    expect(text.trimEnd().split('\n').at(-1)).toBe('#       ForceCommand cvs server');
  });

  it('ne rend actives que les sept directives d\'Ubuntu, les autres sont des valeurs par defaut commentees', async () => {
    const text = await server().executeCommand('cat /etc/ssh/sshd_config');
    const active = text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#')).map((line) => line.split(/\s+/)[0]);
    expect(active).toEqual(['Include', 'KbdInteractiveAuthentication', 'UsePAM', 'X11Forwarding', 'PrintMotd', 'AcceptEnv', 'Subsystem']);
    expect(text).toContain('#PermitRootLogin prohibit-password');
    expect(text).toContain('#MaxAuthTries 6');
  });

  it('a son repertoire sshd_config.d, vide', async () => {
    expect(await server().executeCommand('ls -A /etc/ssh/sshd_config.d')).toBe('');
    expect(await server().executeCommand('test -d /etc/ssh/sshd_config.d && echo dir')).toContain('dir');
  });

  it('les valeurs par defaut sont celles du fichier non touche', async () => {
    const out = await effective();
    expect(out).toMatch(/^permitrootlogin prohibit-password$/m);
    expect(out).toMatch(/^maxauthtries 6$/m);
    expect(out).toMatch(/^x11forwarding yes$/m);
  });
});

describe('Include et « la premiere valeur gagne »', () => {
  it('un fichier de sshd_config.d est lu', async () => {
    await write('/etc/ssh/sshd_config.d/10-hardening.conf', 'MaxAuthTries 3\n');
    expect(await effective()).toMatch(/^maxauthtries 3$/m);
  });

  it('le fichier inclus passe avant les lignes qui suivent Include : il l\'emporte sur sshd_config', async () => {
    await write('/etc/ssh/sshd_config.d/10-hardening.conf', 'PermitRootLogin no\n');
    await server().executeCommand('echo "PermitRootLogin yes" | sudo tee -a /etc/ssh/sshd_config');
    expect(await effective()).toMatch(/^permitrootlogin no$/m);
  });

  it('dans un meme fichier, la premiere valeur gagne', async () => {
    await server().executeCommand('printf "MaxAuthTries 3\\nMaxAuthTries 2\\n" | sudo tee -a /etc/ssh/sshd_config');
    expect(await effective()).toMatch(/^maxauthtries 3$/m);
  });

  it('les fichiers inclus sont lus dans l\'ordre alphabetique', async () => {
    await write('/etc/ssh/sshd_config.d/20-b.conf', 'MaxAuthTries 5\n');
    await write('/etc/ssh/sshd_config.d/10-a.conf', 'MaxAuthTries 4\n');
    expect(await effective()).toMatch(/^maxauthtries 4$/m);
  });

  it('un bloc Match d\'un fichier inclus ne captive pas les lignes de sshd_config qui le suivent', async () => {
    await write('/etc/ssh/sshd_config.d/10-match.conf', 'Match User bob\n  PasswordAuthentication no\n');
    await server().executeCommand('echo "MaxAuthTries 2" | sudo tee -a /etc/ssh/sshd_config');
    expect(await effective()).toMatch(/^maxauthtries 2$/m);
  });

  it('un fichier de sshd_config.d gouverne vraiment la connexion apres un redemarrage', async () => {
    await write('/etc/ssh/sshd_config.d/10-no-password.conf', 'PasswordAuthentication no\n');
    await server().executeCommand('sudo systemctl restart ssh');
    const out = await lan.pc1.executeCommand(`ssh -o StrictHostKeyChecking=accept-new user@${PC2_IP} true`, 'admin\n');
    expect(out).toContain('Permission denied');
  });
});

describe('UsePAM absent', () => {
  it('vaut non, comme dans servconf.c', async () => {
    await server().executeCommand('printf "PrintMotd no\\n" | sudo tee /etc/ssh/sshd_config');
    expect(await effective()).toMatch(/^usepam no$/m);
  });
});
