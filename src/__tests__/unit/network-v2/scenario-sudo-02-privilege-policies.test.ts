/**
 * Scénario 2 — Politiques de privilèges : NOPASSWD, runas, et commandes
 * restreintes.
 *
 * Trois comptes, trois politiques :
 *   - user-admin  : NOPASSWD, ALL sur ALL
 *   - user-reseau : peut seulement redémarrer nginx, et seulement en tant
 *     que "webadmin" (pas root)
 *   - user-lecture: peut seulement `cat` sous /var/log/*, en tant que root
 *
 * Vérifié via `sudo -l -U`, `su - user -c "sudo …"`, et confirmation que
 * ni un argument hors glob ni une injection shell (`; whoami`) ne peuvent
 * élever les privilèges au-delà de la règle exacte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 2 — politiques de privilèges sudo', () => {
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
    await run('useradd -m -s /bin/bash user-admin');
    await run('useradd -m -s /bin/bash user-reseau');
    await run('useradd -m -s /bin/bash user-lecture');
    await run('useradd -m -s /bin/bash webadmin');
    await run(`cat << 'EOF' > /etc/sudoers.d/02-policies
user-admin ALL=(ALL) NOPASSWD: ALL
user-reseau ALL=(webadmin) /bin/systemctl restart nginx
user-lecture ALL=(root) /bin/cat /var/log/*, /bin/cat /etc/hostname
EOF`);
    await run('chmod 440 /etc/sudoers.d/02-policies');
    await run("echo 'auth trail line' > /var/log/auth.log");
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  describe('sudo -l -U reflète chaque politique', () => {
    it('user-admin : NOPASSWD ALL', async () => {
      const out = await run('sudo -l -U user-admin');
      expect(out).toContain('User user-admin may run');
      expect(out).toContain('NOPASSWD: ALL');
    });

    it('user-reseau : commande restreinte, runas webadmin', async () => {
      const out = await run('sudo -l -U user-reseau');
      expect(out).toContain('User user-reseau may run');
      expect(out).toContain('(webadmin) /bin/systemctl restart nginx');
    });

    it('user-lecture : cat restreint à /var/log/*, runas root', async () => {
      const out = await run('sudo -l -U user-lecture');
      expect(out).toContain('User user-lecture may run');
      expect(out).toContain('(root) /bin/cat /var/log/*');
    });
  });

  describe('user-admin : NOPASSWD', () => {
    it('sudo whoami réussit sans mot de passe', async () => {
      const out = await run('su - user-admin -c "sudo whoami"');
      expect(out.trim()).toBe('root');
    });

    it('sudo -S avec un mauvais mot de passe réussit quand même (NOPASSWD ignore la vérification)', async () => {
      const out = await run('su - user-admin -c "echo WRONGPASS | sudo -S whoami"');
      expect(out).toContain('root');
      expect(out).not.toMatch(/incorrect password/);
    });
  });

  describe('user-reseau : commande restreinte + runas restreint', () => {
    it('sudo -u webadmin systemctl restart nginx est autorisé', async () => {
      const out = await run('su - user-reseau -c "sudo -u webadmin systemctl restart nginx"');
      expect(out).not.toMatch(/not allowed to execute/);
      expect(out).not.toMatch(/is not in the sudoers file/);
    });

    it('sudo -u root systemctl restart nginx est refusé (runas non autorisé)', async () => {
      const out = await run('su - user-reseau -c "sudo -u root systemctl restart nginx"');
      expect(out).toMatch(/Sorry, user user-reseau is not allowed to execute/);
    });

    it('sudo -u webadmin whoami (mauvaise commande) est refusé', async () => {
      const out = await run('su - user-reseau -c "sudo -u webadmin whoami"');
      expect(out).toMatch(/Sorry, user user-reseau is not allowed to execute/);
    });

    it('un refus est tracé dans /var/log/auth.log', async () => {
      await run('su - user-reseau -c "sudo -u root whoami"');
      const log = await run('cat /var/log/auth.log');
      expect(log).toMatch(/sudo: user-reseau : command not allowed/);
    });
  });

  describe('user-lecture : commande restreinte par glob d\'arguments', () => {
    it('sudo cat /var/log/auth.log est autorisé', async () => {
      const out = await run('su - user-lecture -c "sudo cat /var/log/auth.log"');
      expect(out).toContain('auth trail line');
    });

    it('sudo cat /etc/shadow (hors du glob autorisé) est refusé — message exact', async () => {
      const out = await run('su - user-lecture -c "sudo cat /etc/shadow"');
      expect(out).toMatch(/Sorry, user user-lecture is not allowed to execute/);
      expect(out).not.toContain('root:');
    });

    it('sudo whoami (commande non listée) est refusé', async () => {
      const out = await run('su - user-lecture -c "sudo whoami"');
      expect(out).toMatch(/Sorry, user user-lecture is not allowed to execute/);
    });
  });

  describe('tentative d\'injection de commande / d\'arguments — aucun contournement', () => {
    it('une règle sans glob (chemin exact) refuse tout argument supplémentaire', async () => {
      const allowed = await run('su - user-lecture -c "sudo cat /etc/hostname"');
      expect(allowed).not.toMatch(/Sorry, user user-lecture is not allowed to execute/);

      const injected = await run('su - user-lecture -c "sudo cat /etc/hostname /etc/shadow"');
      expect(injected).toMatch(/Sorry, user user-lecture is not allowed to execute/);
    });

    it('un glob final ("/var/log/*") reste, comme le vrai sudo (fnmatch), non borné par les espaces', async () => {
      // sudoers évalue les arguments avec fnmatch(), qui ne s'arrête pas
      // aux espaces : une règle terminée par "*" couvre aussi tout ce qui
      // suit un espace. C'est un piège réel et documenté de sudoers, pas
      // un bug du simulateur — donc pas de faux "correctif" ici.
      const out = await run('su - user-lecture -c "sudo cat /var/log/auth.log /etc/shadow"');
      expect(out).not.toMatch(/Sorry, user user-lecture is not allowed to execute/);
    });

    it('un point-virgule après une commande autorisée n\'élève pas la commande suivante', async () => {
      const out = await run('su - user-lecture -c "sudo cat /var/log/auth.log; whoami"');
      expect(out).toContain('auth trail line');
      // whoami s'exécute après le sudo, mais sous l'identité de l'appelant
      // (le sudo précédent restaure son contexte) — jamais sous root.
      expect(out.trim().split('\n').pop()).toBe('user-lecture');
    });

    it('une commande refusée n\'exécute jamais le programme cible', async () => {
      const out = await run('su - user-lecture -c "sudo cat /etc/shadow"');
      expect(out).not.toMatch(/^root:/m);
    });
  });

  describe('cohérence avec canSudo() / accès global', () => {
    it('les trois comptes restreints peuvent quand même invoquer sudo (ils sont dans les sudoers)', async () => {
      for (const u of ['user-admin', 'user-reseau', 'user-lecture']) {
        const out = await run(`su - ${u} -c "sudo -l"`);
        expect(out).not.toMatch(/is not in the sudoers file/);
      }
    });

    it('un utilisateur totalement absent des sudoers reste refusé pour toute commande', async () => {
      await run('useradd -m -s /bin/bash outsider');
      const out = await run('su - outsider -c "sudo whoami"');
      expect(out).toMatch(/is not in the sudoers file/);
    });
  });
});
