/**
 * Scénario 7 — Fichiers /etc/passwd, /etc/shadow, /etc/sudoers : cohérence
 * et sécurité.
 *
 * Valide la structure et les permissions des trois fichiers d'identité, la
 * cohérence croisée passwd/shadow, la détection d'anomalies (UIDs dupliqués,
 * comptes sans mot de passe, comptes système avec shell interactif), et la
 * validation syntaxique de /etc/sudoers via `pwck -r`/`visudo -c`. Chaque
 * test pilote une vraie `LinuxServer` via `executeCommand`.
 *
 * Note de fidélité : le script illustratif du scénario attend
 * `/etc/ssh/sshd_config` en 600 — le défaut réel Ubuntu (et celui de ce
 * simulateur) est 644 (paquet openssh-server, `chmod 644` en postinst) ;
 * 600 est une recommandation de durcissement (CIS), pas le défaut. On
 * garde 644 pour coller à la réalité plutôt qu'à l'énoncé.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 7 — passwd / shadow / sudoers', () => {
  let srv: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  describe('permissions et structure de /etc/passwd', () => {
    it('ls -la liste les trois fichiers avec des permissions restrictives croissantes', async () => {
      const out = await run('ls -la /etc/passwd /etc/shadow /etc/sudoers');
      expect(out).toMatch(/-rw-r--r--.*\/etc\/passwd/);
      expect(out).toMatch(/-rw-r-----.*\/etc\/shadow/);
      expect(out).toMatch(/-r--r-----.*\/etc\/sudoers/);
    });

    it('pwck -r ne retourne aucune erreur sur une configuration saine', async () => {
      const out = await run('pwck -r');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('no errors');
      expect(code).toBe(0);
    });

    it('liste les comptes avec un shell interactif', async () => {
      const out = await run(
        `awk -F: '$7 != "/sbin/nologin" && $7 != "/usr/sbin/nologin" && $7 != "/bin/false" && $7 != "" {print $1, "UID="$3, "shell="$7}' /etc/passwd`,
      );
      expect(out).toContain('root');
      expect(out).toContain('/bin/bash');
    });

    it('détecte les UIDs dupliqués sans faux positif sur une config saine', async () => {
      const clean = await run(
        `awk -F: '{print $3}' /etc/passwd | sort -n | uniq -d`,
      );
      expect(clean.trim()).toBe('');

      // Situation d'incohérence contrôlée : un compte forgé partage l'UID de root.
      await run('echo "intrus:x:0:0:Intrus:/home/intrus:/bin/bash" >> /etc/passwd');
      const dupCheck = await run(
        `awk -F: '{print $3}' /etc/passwd | sort -n | uniq -d`,
      );
      expect(dupCheck.trim()).toBe('0');
      const detail = await run(`grep ":0:" /etc/passwd`);
      expect(detail).toContain('intrus');
      expect(detail).toContain('root');

      const pwckOut = await run('pwck -r');
      const pwckCode = Number((await run('echo $?')).trim());
      expect(pwckOut).toMatch(/duplicate uid 0/);
      expect(pwckCode).toBe(1);
    });

    it('détecte les comptes sans mot de passe sans faux positif sur une config saine', async () => {
      const clean = await run(`awk -F: '$2 == "" {print "DANGER: compte sans mdp:", $1}' /etc/shadow`);
      expect(clean.trim()).toBe('');

      await run('echo "vide:::19000:0:99999:7:::" >> /etc/shadow');
      const withEmpty = await run(`awk -F: '$2 == "" {print "DANGER: compte sans mdp:", $1}' /etc/shadow`);
      expect(withEmpty).toContain('DANGER: compte sans mdp: vide');

      // Un compte verrouillé ('!'/'*') n'est PAS "sans mot de passe" au sens
      // de ce contrôle — pas de faux positif sur daemon/nobody (verrouillés).
      expect(withEmpty).not.toContain('daemon');
      expect(withEmpty).not.toContain('nobody');
    });
  });

  describe('cohérence passwd ↔ shadow', () => {
    it("ne signale aucun compte manquant dans shadow sur une configuration saine", async () => {
      const out = await run(
        `while IFS=: read user pass uid gid gecos home shell; do
  if ! grep -q "^$user:" /etc/shadow 2>/dev/null; then
    echo "MANQUANT dans shadow: $user"
  fi
done < /etc/passwd`,
      );
      expect(out.trim()).toBe('');
    });

    it("détecte un compte passwd sans entrée shadow correspondante", async () => {
      await run('echo "orphelin:x:2000:2000:Orphelin:/home/orphelin:/bin/bash" >> /etc/passwd');
      const out = await run(
        `while IFS=: read user pass uid gid gecos home shell; do
  if ! grep -q "^$user:" /etc/shadow 2>/dev/null; then
    echo "MANQUANT dans shadow: $user"
  fi
done < /etc/passwd`,
      );
      expect(out.trim()).toBe('MANQUANT dans shadow: orphelin');

      const pwckOut = await run('pwck -r');
      const pwckCode = Number((await run('echo $?')).trim());
      expect(pwckOut).toContain("user 'orphelin' in /etc/passwd but not in /etc/shadow");
      expect(pwckCode).toBe(1);
    });

    it('ne signale aucun compte système avec shell interactif sur une configuration saine', async () => {
      const out = await run(
        `awk -F: '$3 < 1000 && $7 != "/sbin/nologin" && $7 != "/usr/sbin/nologin" && $7 != "/bin/false" && $1 != "root" {print "SUSPECT:", $1, "UID="$3, "shell="$7}' /etc/passwd`,
      );
      expect(out.trim()).toBe('');
    });

    it('détecte un compte système forgé avec un shell interactif', async () => {
      await run('useradd -r -s /bin/bash backdoor');
      const out = await run(
        `awk -F: '$3 < 1000 && $7 != "/sbin/nologin" && $7 != "/usr/sbin/nologin" && $7 != "/bin/false" && $1 != "root" {print "SUSPECT:", $1, "UID="$3, "shell="$7}' /etc/passwd`,
      );
      expect(out).toContain('SUSPECT: backdoor');
      expect(out).toContain('/bin/bash');
    });
  });

  describe('validation de /etc/sudoers', () => {
    it('visudo -c -f valide la syntaxe du sudoers par défaut', async () => {
      const out = await run('visudo -c -f /etc/sudoers');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('/etc/sudoers: parsed OK');
      expect(code).toBe(0);
    });

    it('visudo -c -f rejette une ligne sudoers syntaxiquement invalide', async () => {
      await run(`echo 'deploy ALL(ALL) NOPASSWD: ALL' > /tmp/bad-sudoers`);
      const out = await run('visudo -c -f /tmp/bad-sudoers');
      const code = Number((await run('echo $?')).trim());
      expect(out).toMatch(/syntax error near line 1/);
      expect(code).toBe(1);
    });

    it('visudo -c -f accepte une règle NOPASSWD bien formée', async () => {
      await run(`echo 'deploy ALL=(ALL) NOPASSWD: ALL' > /tmp/good-sudoers`);
      const out = await run('visudo -c -f /tmp/good-sudoers');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('parsed OK');
      expect(code).toBe(0);
    });

    it('détecte les règles NOPASSWD ALL et sudo complet via grep', async () => {
      await run(`cat << 'EOF' > /etc/sudoers.d/mandeng-test
deploy ALL=(ALL) NOPASSWD: ALL
backup ALL=(root) NOPASSWD: /usr/bin/rsync
alice ALL=(ALL:ALL) ALL
EOF`);
      const nopasswd = await run(
        `grep -n 'NOPASSWD.*ALL' /etc/sudoers /etc/sudoers.d/* 2>/dev/null | awk '{print "DANGER NOPASSWD ALL:", $0}'`,
      );
      expect(nopasswd).toContain('DANGER NOPASSWD ALL:');
      expect(nopasswd).toContain('deploy ALL=(ALL) NOPASSWD: ALL');
      // backup n'a pas NOPASSWD .* ALL (commande restreinte à rsync) — pas de faux positif.
      expect(nopasswd).not.toContain('backup');

      const fullSudo = await run(
        `grep -n 'ALL=(ALL.*) ALL' /etc/sudoers /etc/sudoers.d/* 2>/dev/null | grep -v '^#' | awk '{print "SUDO COMPLET:", $0}'`,
      );
      expect(fullSudo).toContain('SUDO COMPLET:');
      expect(fullSudo).toContain('root ALL=(ALL:ALL) ALL');
      expect(fullSudo).toContain('alice ALL=(ALL:ALL) ALL');
    });

    it('valide chaque fichier de /etc/sudoers.d/ individuellement', async () => {
      await run(`echo 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ops`);
      await run(`echo 'broken ALL(ALL) ALL' > /etc/sudoers.d/broken`);

      const okOut = await run('visudo -c -f /etc/sudoers.d/ops');
      const okCode = Number((await run('echo $?')).trim());
      expect(okCode).toBe(0);
      expect(okOut).toContain('parsed OK');

      const brokenOut = await run('visudo -c -f /etc/sudoers.d/broken');
      const brokenCode = Number((await run('echo $?')).trim());
      expect(brokenOut).toMatch(/syntax error/);
      expect(brokenCode).toBe(1);
    });
  });

  describe('audit des permissions des fichiers sensibles', () => {
    async function checkPerms(file: string): Promise<{ perms: string; owner: string }> {
      const perms = (await run(`stat -c '%a' ${file}`)).trim();
      const owner = (await run(`stat -c '%U' ${file}`)).trim();
      return { perms, owner };
    }

    it('/etc/passwd est 644 root', async () => {
      const { perms, owner } = await checkPerms('/etc/passwd');
      expect(perms).toBe('644');
      expect(owner).toBe('root');
    });

    it('/etc/shadow est 640 root', async () => {
      const { perms, owner } = await checkPerms('/etc/shadow');
      expect(perms).toBe('640');
      expect(owner).toBe('root');
    });

    it('/etc/sudoers est 440 root', async () => {
      const { perms, owner } = await checkPerms('/etc/sudoers');
      expect(perms).toBe('440');
      expect(owner).toBe('root');
    });

    it('/etc/ssh/sshd_config est 644 root (défaut réel Ubuntu, pas 600)', async () => {
      // Force la matérialisation de sshd_config (créé paresseusement au premier accès SSH).
      await run('systemctl start ssh');
      const { perms, owner } = await checkPerms('/etc/ssh/sshd_config');
      expect(perms).toBe('644');
      expect(owner).toBe('root');
    });
  });
});
