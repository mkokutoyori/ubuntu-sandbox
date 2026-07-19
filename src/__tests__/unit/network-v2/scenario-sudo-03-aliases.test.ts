/**
 * Scénario 3 — Gestion des alias sudoers : User_Alias, Cmnd_Alias,
 * Host_Alias, Runas_Alias.
 *
 * Résolution des quatre types d'alias, négation (`!INTERDITES` bloque une
 * commande même pour un utilisateur avec `ALL`), restriction par
 * Host_Alias (CIDR), et propagation immédiate d'un ajout à un alias — pas
 * de rechargement de service requis, puisque la politique est reparsée à
 * chaque invocation de sudo.
 *
 * Note : `LinuxServer` pré-provisionne alice/bob/carl/dave dans le groupe
 * `sudo` (pour les tests SSH croisés) — on utilise donc d'autres noms ici
 * pour que les règles testées soient les seules en jeu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';

describe('Scénario 3 — alias sudoers (User_Alias/Cmnd_Alias/Host_Alias/Runas_Alias)', () => {
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
    srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
    await run('useradd -m -s /bin/bash netadmin');
    await run('useradd -m -s /bin/bash guest1');
    await run('useradd -m -s /bin/bash auditor1');
    await run('useradd -m -s /bin/bash webadmin');
    await run(`cat << 'EOF' > /etc/sudoers.d/03-aliases
User_Alias ADMINS = netadmin
User_Alias AUDITEURS = auditor1
Cmnd_Alias RESEAU_LECTURE = /sbin/ip, /usr/sbin/ss
Cmnd_Alias INTERDITES = /bin/rm, /usr/bin/passwd
Host_Alias LAN_MANDENG = 10.0.0.0/24
Runas_Alias COMPTES_ADMIN = root, webadmin
ADMINS LAN_MANDENG = (COMPTES_ADMIN) ALL, !INTERDITES
AUDITEURS LAN_MANDENG = (root) RESEAU_LECTURE
EOF`);
    await run('chmod 440 /etc/sudoers.d/03-aliases');
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  describe('résolution des quatre types d\'alias', () => {
    it('User_Alias : netadmin (membre de ADMINS) peut sudo, guest1 (non membre) ne peut pas', async () => {
      const adminOut = await run('su - netadmin -c "sudo whoami"');
      expect(adminOut.trim()).toBe('root');
      const guestOut = await run('su - guest1 -c "sudo whoami"');
      expect(guestOut).toMatch(/is not in the sudoers file/);
    });

    it('Cmnd_Alias : auditor1 (AUDITEURS) peut ip et ss mais pas whoami', async () => {
      const ipOut = await run('su - auditor1 -c "sudo ip addr show"');
      expect(ipOut).not.toMatch(/Sorry, user auditor1 is not allowed to execute/);
      const ssOut = await run('su - auditor1 -c "sudo ss -tlnp"');
      expect(ssOut).not.toMatch(/Sorry, user auditor1 is not allowed to execute/);
      const whoamiOut = await run('su - auditor1 -c "sudo whoami"');
      expect(whoamiOut).toMatch(/Sorry, user auditor1 is not allowed to execute/);
    });

    it('Runas_Alias : netadmin peut exécuter en tant que webadmin (membre de COMPTES_ADMIN)', async () => {
      const out = await run('su - netadmin -c "sudo -u webadmin whoami"');
      expect(out.trim()).toBe('webadmin');
    });

    it('Runas_Alias : netadmin ne peut pas exécuter en tant qu\'un utilisateur hors COMPTES_ADMIN', async () => {
      await run('useradd -m -s /bin/bash outsider');
      const out = await run('su - netadmin -c "sudo -u outsider whoami"');
      expect(out).toMatch(/Sorry, user netadmin is not allowed to execute/);
    });

    it('Host_Alias : LAN_MANDENG (10.0.0.0/24) matche l\'IP configurée de la machine', async () => {
      const out = await run('su - netadmin -c "sudo whoami"');
      expect(out.trim()).toBe('root');
    });
  });

  describe('négation : !INTERDITES bloque une commande même pour un utilisateur avec ALL', () => {
    it('netadmin (ALL) ne peut pas rm malgré le "ALL" — INTERDITES le bloque explicitement', async () => {
      const out = await run('su - netadmin -c "sudo rm /tmp/foo"');
      expect(out).toMatch(/Sorry, user netadmin is not allowed to execute/);
    });

    it('netadmin (ALL) ne peut pas passwd — également dans INTERDITES', async () => {
      const out = await run('su - netadmin -c "sudo passwd root"');
      expect(out).toMatch(/Sorry, user netadmin is not allowed to execute/);
    });

    it('netadmin (ALL) peut en revanche toute autre commande non listée dans INTERDITES', async () => {
      const out = await run('su - netadmin -c "sudo cat /etc/hostname"');
      expect(out).not.toMatch(/Sorry, user netadmin is not allowed to execute/);
    });
  });

  describe('Host_Alias : restriction CIDR effective', () => {
    it('hors du CIDR LAN_MANDENG, la règle ADMINS ne s\'applique plus — netadmin perd son accès', async () => {
      srv.getPorts()[0].configureIP(new IPAddress('192.168.50.10'), new SubnetMask('255.255.255.0'));
      const out = await run('su - netadmin -c "sudo whoami"');
      expect(out).toMatch(/is not in the sudoers file/);
    });

    it('en revenant dans le CIDR, l\'accès est restauré sans aucune autre action', async () => {
      srv.getPorts()[0].configureIP(new IPAddress('192.168.50.10'), new SubnetMask('255.255.255.0'));
      expect((await run('su - netadmin -c "sudo whoami"'))).toMatch(/is not in the sudoers file/);

      srv.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
      expect((await run('su - netadmin -c "sudo whoami"')).trim()).toBe('root');
    });
  });

  describe('propagation immédiate d\'un ajout à un alias (sed -i, sans rechargement de service)', () => {
    it('guest1 n\'a initialement pas accès (non membre de ADMINS)', async () => {
      const out = await run('su - guest1 -c "sudo whoami"');
      expect(out).toMatch(/is not in the sudoers file/);
    });

    it('après ajout de guest1 à ADMINS via sed -i, l\'accès est immédiat — pas de "systemctl reload" nécessaire', async () => {
      await run("sed -i 's/User_Alias ADMINS = netadmin/User_Alias ADMINS = netadmin,guest1/' /etc/sudoers.d/03-aliases");
      const out = await run('su - guest1 -c "sudo whoami"');
      expect(out.trim()).toBe('root');
    });

    it('guest1 hérite aussi de la négation INTERDITES une fois ajouté à ADMINS', async () => {
      await run("sed -i 's/User_Alias ADMINS = netadmin/User_Alias ADMINS = netadmin,guest1/' /etc/sudoers.d/03-aliases");
      const out = await run('su - guest1 -c "sudo rm /tmp/foo"');
      expect(out).toMatch(/Sorry, user guest1 is not allowed to execute/);
    });
  });
});
