/**
 * Scénario 4 — /etc/sudoers.d/ : inclusion de fichiers multiples et ordre
 * de priorité.
 *
 * `/etc/sudoers` référence `#includedir /etc/sudoers.d` ; les fichiers y
 * sont inclus par ordre alphabétique, avec permissions 440 obligatoires
 * (celles créées par `visudo -f` le sont automatiquement). Un fichier
 * syntaxiquement invalide n'importe où dans la chaîne bloque *tout* sudo
 * (fail-closed) ; un fichier aux permissions trop larges (644) est
 * seulement ignoré (fail-safe, pas fatal) ; les extensions `.bak` sont
 * ignorées silencieusement, comme le vrai `#includedir`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

let srv: LinuxServer;
let session: LinuxTerminalSession;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  srv.powerOn();
  session = new LinuxTerminalSession('term-1', srv);
});

async function run(cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

async function visudoFCreate(path: string, content: string): Promise<void> {
  await type(`visudo -f ${path}`);
  const mode = session.inputMode as { absolutePath: string };
  session.editorSave(content, mode.absolutePath);
  session.editorExit(true);
  await flush();
}

describe('Scénario 4 — /etc/sudoers.d/ : inclusion multiple et priorité', () => {
  it('/etc/sudoers référence #includedir /etc/sudoers.d', async () => {
    const out = await run("grep -E 'includedir|#include' /etc/sudoers");
    expect(out).toMatch(/#includedir \/etc\/sudoers\.d/);
  });

  describe('création via visudo -f : permissions 440 automatiques', () => {
    it('un fichier créé via visudo -f est automatiquement root:root 0440', async () => {
      await visudoFCreate('/etc/sudoers.d/01-reseau', 'opuser ALL=(root) ALL\n');
      const out = await run('stat -c "%a %U:%G" /etc/sudoers.d/01-reseau');
      expect(out.trim()).toBe('440 root:root');
    });

    it('trois fichiers 01-reseau/02-audit/03-devops sont tous créés 440 root:root', async () => {
      await visudoFCreate('/etc/sudoers.d/01-reseau', 'netuser ALL=(root) /sbin/ip\n');
      await visudoFCreate('/etc/sudoers.d/02-audit', 'audituser ALL=(root) /usr/sbin/ss\n');
      await visudoFCreate('/etc/sudoers.d/03-devops', 'devopsuser ALL=(root) ALL\n');
      for (const f of ['01-reseau', '02-audit', '03-devops']) {
        const out = await run(`stat -c "%a %U:%G" /etc/sudoers.d/${f}`);
        expect(out.trim()).toBe('440 root:root');
      }
    });
  });

  describe('ordre alphabétique : dernière règle qui matche l\'emporte', () => {
    beforeEach(async () => {
      await run('useradd -m -s /bin/bash opuser');
      await visudoFCreate('/etc/sudoers.d/01-reseau', 'opuser ALL=(root) ALL\n');
      await visudoFCreate('/etc/sudoers.d/02-audit', 'opuser ALL=(root) !/bin/rm\n');
    });

    it('02-audit (après 01-reseau) restreint rm malgré le ALL de 01-reseau', async () => {
      const out = await run('su - opuser -c "sudo rm /tmp/x"');
      expect(out).toMatch(/Sorry, user opuser is not allowed to execute/);
    });

    it('02-audit ne touche pas aux autres commandes — toujours autorisées via 01-reseau', async () => {
      const out = await run('su - opuser -c "sudo cat /etc/hostname"');
      expect(out).not.toMatch(/Sorry, user opuser is not allowed to execute/);
    });

    it('renommer pour inverser l\'ordre alphabétique inverse l\'effet (00 avant 01)', async () => {
      // 02-audit (restriction) devient 00-audit : traité *avant* 01-reseau,
      // qui redonne ensuite ALL — la restriction est donc annulée.
      await run('mv /etc/sudoers.d/02-audit /etc/sudoers.d/00-audit');
      const out = await run('su - opuser -c "sudo rm /tmp/x"');
      expect(out).not.toMatch(/Sorry, user opuser is not allowed to execute/);
    });
  });

  describe('fichier syntaxiquement invalide : bloque tout sudo (fail-closed)', () => {
    beforeEach(async () => {
      await run('useradd -m -s /bin/bash opuser');
      await run('useradd -m -s /bin/bash otheruser');
      await visudoFCreate('/etc/sudoers.d/01-reseau', 'opuser ALL=(root) ALL\n');
    });

    it('avant le fichier invalide, opuser a bien accès', async () => {
      const out = await run('su - opuser -c "sudo whoami"');
      expect(out.trim()).toBe('root');
    });

    it('un 99-invalide syntaxiquement cassé bloque opuser (qui fonctionnait) ET root (via /etc/sudoers lui-même)', async () => {
      await run("echo 'opuser ALL ALL' > /etc/sudoers.d/99-invalide");
      await run('chmod 440 /etc/sudoers.d/99-invalide');

      const opuserOut = await run('su - opuser -c "sudo whoami"');
      expect(opuserOut).toMatch(/is not in the sudoers file/);

      const otherOut = await run('su - otheruser -c "sudo whoami"');
      expect(otherOut).toMatch(/is not in the sudoers file/);
    });

    it('visudo -c (sans -f) rapporte la ligne fautive du fichier en cause et exit non nul', async () => {
      await run("echo 'opuser ALL ALL' > /etc/sudoers.d/99-invalide");
      await run('chmod 440 /etc/sudoers.d/99-invalide');
      const out = await run('visudo -c; echo "EXIT:$?"');
      expect(out).toMatch(/\/etc\/sudoers\.d\/99-invalide: syntax error near line 1/);
      expect(out).not.toContain('EXIT:0');
    });

    it('après suppression du fichier invalide, l\'accès est restauré immédiatement', async () => {
      await run("echo 'opuser ALL ALL' > /etc/sudoers.d/99-invalide");
      await run('chmod 440 /etc/sudoers.d/99-invalide');
      expect(await run('su - opuser -c "sudo whoami"')).toMatch(/is not in the sudoers file/);

      await run('rm /etc/sudoers.d/99-invalide');
      expect((await run('su - opuser -c "sudo whoami"')).trim()).toBe('root');
    });
  });

  describe('permissions 644 : fichier ignoré, pas fatal au reste de la chaîne', () => {
    beforeEach(async () => {
      await run('useradd -m -s /bin/bash opuser');
      await run('useradd -m -s /bin/bash laxuser');
      await visudoFCreate('/etc/sudoers.d/01-reseau', 'opuser ALL=(root) ALL\n');
      await run("echo 'laxuser ALL=(root) ALL' > /etc/sudoers.d/02-lax");
      await run('chmod 644 /etc/sudoers.d/02-lax');
    });

    it('le fichier 644 est ignoré : laxuser n\'obtient pas l\'accès qu\'il y décrit', async () => {
      const out = await run('su - laxuser -c "sudo whoami"');
      expect(out).toMatch(/is not in the sudoers file/);
    });

    it('les autres fichiers de la chaîne (0440) restent pleinement actifs', async () => {
      const out = await run('su - opuser -c "sudo whoami"');
      expect(out.trim()).toBe('root');
    });

    it('visudo -c (sans -f) signale explicitement le fichier aux permissions trop larges', async () => {
      const out = await run('visudo -c');
      expect(out).toMatch(/02-lax.*insecure permissions/);
    });

    it('visudo -c (sans -f) reste exit 0 — un fichier ignoré n\'est pas une erreur de syntaxe', async () => {
      const out = await run('visudo -c; echo "EXIT:$?"');
      expect(out).toContain('EXIT:0');
    });
  });

  describe('extension .bak : ignorée silencieusement, comme le vrai #includedir', () => {
    it('un fichier nommé "*.bak" dans sudoers.d n\'est jamais pris en compte, même syntaxiquement invalide', async () => {
      await run('useradd -m -s /bin/bash opuser');
      await visudoFCreate('/etc/sudoers.d/01-reseau', 'opuser ALL=(root) ALL\n');
      await run("echo 'this is not valid sudoers at all' > /etc/sudoers.d/01-reseau.bak");
      await run('chmod 440 /etc/sudoers.d/01-reseau.bak');

      // Le .bak cassé ne doit ni bloquer sudo (fail-closed) ni apparaître
      // dans les commandes autorisées.
      const out = await run('su - opuser -c "sudo whoami"');
      expect(out.trim()).toBe('root');
    });

    it('visudo -c (sans -f) ne rapporte aucun statut pour le fichier .bak', async () => {
      await run("echo 'garbage' > /etc/sudoers.d/whatever.bak");
      await run('chmod 440 /etc/sudoers.d/whatever.bak');
      const out = await run('visudo -c');
      expect(out).not.toContain('whatever.bak');
    });
  });
});
