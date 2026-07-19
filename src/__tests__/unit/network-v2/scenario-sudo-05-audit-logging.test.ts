/**
 * Scénario 5 — Sécurité sudo : logs, audit des commandes, et tentatives
 * non autorisées.
 *
 * Chaque invocation de sudo (succès, NOPASSWD, ou refus) doit produire
 * une entrée `/var/log/auth.log` correspondante avec l'utilisateur réel,
 * le TTY, le PWD, `USER=` (la cible réelle du runas), et `COMMAND=`
 * complet avec ses arguments. Les refus sont distingués des succès par
 * les mots-clés `NOT in sudoers` / `not allowed`. `Defaults
 * logfile=/var/log/sudo.log` fait écrire les mêmes lignes en plus dans ce
 * fichier, en complément d'auth.log (pas à sa place).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let srv: LinuxServer;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  srv.powerOn();
  await run('useradd -m -s /bin/bash netadmin');
  await run('useradd -m -s /bin/bash guest1');
  await run(`cat << 'EOF' > /etc/sudoers.d/05-audit
netadmin ALL=(ALL) NOPASSWD: ALL
EOF`);
  await run('chmod 440 /etc/sudoers.d/05-audit');
});

async function run(cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

async function authLog(): Promise<string> {
  return run('cat /var/log/auth.log');
}

describe('Scénario 5 — audit sudo : succès, refus, NOPASSWD', () => {
  it('un sudo réussi produit une ligne complète : user, TTY, PWD, USER=, COMMAND=', async () => {
    await run('su - netadmin -c "sudo cat /etc/hostname"');
    const log = await authLog();
    expect(log).toMatch(/sudo: netadmin : TTY=pts\/0 ; PWD=\/home\/netadmin ; USER=root ; COMMAND=\/usr\/bin\/cat \/etc\/hostname/);
  });

  it('un sudo NOPASSWD réussi est tracé comme un succès normal (pas de mention de mot de passe)', async () => {
    await run('su - netadmin -c "sudo whoami"');
    const log = await authLog();
    const line = log.split('\n').find((l) => l.includes('COMMAND=/usr/bin/whoami'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/incorrect password|authentication failure/);
  });

  it('un refus "not in sudoers" est distinguable par le mot-clé exact', async () => {
    await run('su - guest1 -c "sudo whoami"');
    const log = await authLog();
    expect(log).toMatch(/sudo: guest1 : user NOT in sudoers ; TTY=pts\/0 ; PWD=\/home\/guest1 ; USER=root ; COMMAND=\/usr\/bin\/whoami/);
  });

  it('un refus "commande non autorisée" est distinguable par un mot-clé différent ("not allowed")', async () => {
    await run(`cat << 'EOF' >> /etc/sudoers.d/05-audit
guest1 ALL=(root) /bin/cat /etc/hostname
EOF`);
    await run('su - guest1 -c "sudo whoami"');
    const log = await authLog();
    expect(log).toMatch(/sudo: guest1 : command not allowed ; TTY=pts\/0 ; PWD=\/home\/guest1 ; USER=root ; COMMAND=\/usr\/bin\/whoami/);
    // Le message utilisateur (pas la ligne de log) porte "not allowed".
    const out = await run('su - guest1 -c "sudo whoami"');
    expect(out).toMatch(/Sorry, user guest1 is not allowed to execute/);
  });

  it('succès et refus sont grep-ables séparément grâce à ces mots-clés', async () => {
    await run('su - netadmin -c "sudo whoami"');
    await run('su - guest1 -c "sudo whoami"');
    const refused = await run("grep 'NOT in sudoers' /var/log/auth.log");
    const succeeded = await run("grep 'sudo: netadmin :' /var/log/auth.log | grep -v 'NOT in sudoers'");
    expect(refused).toContain('guest1');
    expect(succeeded).toContain('netadmin');
  });

  it('USER= reflète la cible réelle du runas (-u), pas toujours root', async () => {
    await run('useradd -m -s /bin/bash svcaccount');
    await run(`cat << 'EOF' >> /etc/sudoers.d/05-audit
netadmin ALL=(svcaccount) NOPASSWD: ALL
EOF`);
    await run('su - netadmin -c "sudo -u svcaccount whoami"');
    const log = await authLog();
    expect(log).toMatch(/sudo: netadmin : TTY=pts\/0 ; PWD=\/home\/netadmin ; USER=svcaccount ; COMMAND=\/usr\/bin\/whoami/);
  });

  it('COMMAND= inclut les arguments complets, pas seulement le nom de la commande', async () => {
    await run('su - netadmin -c "sudo cat /etc/passwd /etc/hostname"');
    const log = await authLog();
    expect(log).toContain('COMMAND=/usr/bin/cat /etc/passwd /etc/hostname');
  });

  it('un mauvais mot de passe (sudo -S, hors NOPASSWD) est tracé distinctement', async () => {
    await run(`cat << 'EOF' >> /etc/sudoers.d/05-audit
guest1 ALL=(root) ALL
EOF`);
    await run('su - guest1 -c "echo WRONGPASS | sudo -S whoami"');
    const log = await authLog();
    expect(log).toMatch(/sudo: pam_unix\(sudo:auth\): authentication failure/);
    expect(log).toMatch(/sudo:  guest1 : 1 incorrect password attempt/);
  });
});

describe('Scénario 5 — Defaults logfile=/var/log/sudo.log (en plus d\'auth.log)', () => {
  beforeEach(async () => {
    await run(`cat << 'EOF' >> /etc/sudoers.d/05-audit
Defaults logfile=/var/log/sudo.log
EOF`);
  });

  it('un sudo réussi écrit la même ligne dans auth.log ET dans le logfile personnalisé', async () => {
    await run('su - netadmin -c "sudo whoami"');
    const auth = await authLog();
    const custom = await run('cat /var/log/sudo.log');
    expect(auth).toContain('COMMAND=/usr/bin/whoami');
    expect(custom).toContain('COMMAND=/usr/bin/whoami');
  });

  it('un refus est également dupliqué dans le logfile personnalisé', async () => {
    await run('su - guest1 -c "sudo whoami"');
    const custom = await run('cat /var/log/sudo.log');
    expect(custom).toMatch(/user NOT in sudoers/);
  });

  it('visudo -c valide "Defaults logfile=" sans erreur', async () => {
    const out = await run('visudo -c; echo "EXIT:$?"');
    expect(out).toContain('EXIT:0');
  });
});
