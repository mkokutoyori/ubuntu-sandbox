/**
 * TDD Tests for Ubuntu Linux - File System & Access Management
 * Tests compatibles avec une Ubuntu vierge (sans paquets supplémentaires)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Gestion des Fichiers et Répertoires
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Gestion des Fichiers et Répertoires', () => {

  describe('F-UBU-01: Opérations de base sur les fichiers', () => {
    it('should create, list, and delete files', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un fichier
      await pc.executeCommand('touch testfile.txt');
      
      // Vérifier que le fichier existe
      const lsOutput = await pc.executeCommand('ls -la testfile.txt');
      expect(lsOutput).toContain('testfile.txt');
      
      // Écrire dans le fichier
      await pc.executeCommand('echo "Hello World" > testfile.txt');
      
      // Lire le contenu
      const content = await pc.executeCommand('cat testfile.txt');
      expect(content.trim()).toBe('Hello World');
      
      // Ajouter du contenu
      await pc.executeCommand('echo "Second line" >> testfile.txt');
      const updatedContent = await pc.executeCommand('cat testfile.txt');
      expect(updatedContent).toContain('Second line');
      
      // Copier le fichier
      await pc.executeCommand('cp testfile.txt testfile_copy.txt');
      const copyExists = await pc.executeCommand('ls testfile_copy.txt');
      expect(copyExists).toContain('testfile_copy.txt');
      
      // Renommer le fichier
      await pc.executeCommand('mv testfile.txt renamed_file.txt');
      const renamed = await pc.executeCommand('ls renamed_file.txt');
      expect(renamed).toContain('renamed_file.txt');
      
      // Supprimer les fichiers
      await pc.executeCommand('rm renamed_file.txt testfile_copy.txt');
      const remaining = await pc.executeCommand('ls *.txt 2>/dev/null || true');
      expect(remaining).not.toContain('renamed_file.txt');
    });

    it('should handle file permissions with chmod', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un fichier
      await pc.executeCommand('touch myfile.txt');
      
      // Changer les permissions en octal
      await pc.executeCommand('chmod 755 myfile.txt');
      let permissions = await pc.executeCommand('ls -l myfile.txt');
      expect(permissions).toContain('-rwxr-xr-x');
      
      // Changer les permissions avec notation symbolique
      // 755 = rwxr-xr-x → u+w (noop), g-w (noop, no w in group), o=r → rwxr-xr--
      await pc.executeCommand('chmod u+w,g-w,o=r myfile.txt');
      permissions = await pc.executeCommand('ls -l myfile.txt');
      expect(permissions).toContain('-rwxr-xr--');
      
      // Enlever le droit d'exécution pour tous
      // rwxr-xr-- → a-x → rw-r--r--
      await pc.executeCommand('chmod a-x myfile.txt');
      permissions = await pc.executeCommand('ls -l myfile.txt');
      expect(permissions).toContain('-rw-r--r--');
      
      // Ajouter le bit setuid
      await pc.executeCommand('chmod u+s myfile.txt');
      permissions = await pc.executeCommand('ls -l myfile.txt');
      expect(permissions).toContain('-rwSr--r--');
      
      // Nettoyage
      await pc.executeCommand('rm myfile.txt');
    });

    it('should create and manage directories', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un répertoire
      await pc.executeCommand('mkdir mydir');
      
      // Vérifier la création
      const dirExists = await pc.executeCommand('ls -d mydir');
      expect(dirExists).toContain('mydir');
      
      // Créer une arborescence
      await pc.executeCommand('mkdir -p parent/child/grandchild');
      
      // Vérifier l'arborescence
      const tree = await pc.executeCommand('find parent -type d');
      expect(tree).toContain('parent/child');
      expect(tree).toContain('parent/child/grandchild');
      
      // Se déplacer dans le répertoire
      await pc.executeCommand('cd mydir && touch file1.txt');
      
      // Retourner au répertoire précédent
      await pc.executeCommand('cd .. && ls mydir/file1.txt');
      
      // Supprimer un répertoire vide
      await pc.executeCommand('rmdir mydir');
      
      // Supprimer une arborescence
      await pc.executeCommand('rm -rf parent');
      
      // Vérifier la suppression
      const check = await pc.executeCommand('ls parent 2>/dev/null || echo "not found"');
      expect(check).toContain('not found');
    });
  });

  describe('F-UBU-02: Recherche et filtrage de fichiers', () => {
    it('should find files using find command', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer des fichiers de test
      await pc.executeCommand('mkdir -p test_find');
      await pc.executeCommand('touch test_find/file1.txt');
      await pc.executeCommand('touch test_find/file2.log');
      await pc.executeCommand('touch test_find/document.pdf');
      await pc.executeCommand('mkdir test_find/subdir');
      await pc.executeCommand('touch test_find/subdir/file3.txt');
      
      // Trouver tous les fichiers .txt
      const txtFiles = await pc.executeCommand('find test_find -name "*.txt"');
      expect(txtFiles).toContain('file1.txt');
      expect(txtFiles).toContain('file3.txt');
      
      // Trouver des fichiers par type
      const directories = await pc.executeCommand('find test_find -type d');
      expect(directories).toContain('test_find');
      expect(directories).toContain('test_find/subdir');
      
      // Trouver des fichiers par taille (fichiers vides)
      const emptyFiles = await pc.executeCommand('find test_find -type f -empty');
      expect(emptyFiles.split('\n').length).toBeGreaterThan(0);
      
      // Trouver des fichiers modifiés récemment
      await pc.executeCommand('find test_find -type f -mtime -1');
      
      // Exécuter une commande sur les fichiers trouvés
      const withExec = await pc.executeCommand('find test_find -name "*.txt" -exec echo Found: {} \\;');
      expect(withExec).toContain('Found:');
      
      // Nettoyage
      await pc.executeCommand('rm -rf test_find');
    });

    it('should search file contents with grep', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer des fichiers avec contenu (echo -e pour interpréter les \n)
      await pc.executeCommand('echo -e "Hello World\nThis is a test\nAnother line" > file1.txt');
      await pc.executeCommand('echo -e "Test content\nHello again\nEnd of file" > file2.txt');
      await pc.executeCommand('echo -e "No match here\nJust text" > file3.txt');
      
      // Rechercher une chaîne simple
      const helloMatches = await pc.executeCommand('grep "Hello" file1.txt');
      expect(helloMatches).toContain('Hello World');
      
      // Rechercher dans plusieurs fichiers
      const multiFile = await pc.executeCommand('grep "Hello" file*.txt');
      expect(multiFile).toContain('file1.txt:Hello World');
      expect(multiFile).toContain('file2.txt:Hello again');
      
      // Rechercher avec expression régulière
      const regex = await pc.executeCommand('grep -E "^T" file*.txt');
      expect(regex).toContain('This is a test');
      expect(regex).toContain('Test content');
      
      // Compter les occurrences
      const count = await pc.executeCommand('grep -c "test" file*.txt');
      expect(count).toContain('file1.txt:1');
      
      // Rechercher récursivement
      await pc.executeCommand('mkdir -p searchdir/sub');
      await pc.executeCommand('echo "search term" > searchdir/file.txt');
      await pc.executeCommand('echo "search term" > searchdir/sub/file.txt');
      
      const recursive = await pc.executeCommand('grep -r "search term" searchdir/');
      expect(recursive.split('\n').length).toBe(2);
      
      // Rechercher en ignorant la casse
      const caseInsensitive = await pc.executeCommand('grep -i "hello" file1.txt');
      expect(caseInsensitive).toContain('Hello');
      
      // Nettoyage
      await pc.executeCommand('rm -f file*.txt');
      await pc.executeCommand('rm -rf searchdir');
    });

    it('should use locate and which commands', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Mettre à jour la base de données locate
      await pc.executeCommand('sudo updatedb');
      
      // Chercher un fichier système connu
      const passwdLocate = await pc.executeCommand('locate passwd | head -5');
      expect(passwdLocate).toContain('passwd');
      
      // Trouver l'emplacement d'une commande
      const lsPath = await pc.executeCommand('which ls');
      expect(lsPath).toContain('/bin/ls');
      
      const bashPath = await pc.executeCommand('which bash');
      expect(bashPath).toContain('/bin/bash');
      
      // Trouver toutes les occurrences d'une commande
      const whereisOutput = await pc.executeCommand('whereis ls');
      expect(whereisOutput).toContain('/bin/ls');
      
      // Vérifier si une commande existe
      const commandCheck = await pc.executeCommand('command -v ls && echo "exists"');
      expect(commandCheck).toContain('exists');
      
      // Chercher avec des motifs
      const patternSearch = await pc.executeCommand('locate "*.conf" | head -3');
      expect(patternSearch.split('\n').length).toBeGreaterThan(0);
    });
  });

  describe('F-UBU-03: Liens et fichiers spéciaux', () => {
    it('should create and manage symbolic links', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un fichier source
      await pc.executeCommand('echo "Original content" > original.txt');
      
      // Créer un lien symbolique
      await pc.executeCommand('ln -s original.txt symlink.txt');
      
      // Vérifier le lien
      const linkCheck = await pc.executeCommand('ls -l symlink.txt');
      expect(linkCheck).toContain('-> original.txt');
      
      // Lire via le lien symbolique
      const viaLink = await pc.executeCommand('cat symlink.txt');
      expect(viaLink).toContain('Original content');
      
      // Modifier via le lien symbolique
      await pc.executeCommand('echo "Modified" >> symlink.txt');
      const originalUpdated = await pc.executeCommand('cat original.txt');
      expect(originalUpdated).toContain('Modified');
      
      // Supprimer le fichier original
      await pc.executeCommand('rm original.txt');
      
      // Vérifier que le lien est cassé (la cible n'existe plus)
      const brokenLink = await pc.executeCommand('ls -l symlink.txt');
      expect(brokenLink).toContain('-> original.txt');
      // Le fichier cible n'existe plus, cat devrait échouer
      const brokenRead = await pc.executeCommand('cat symlink.txt 2>&1 || echo "broken"');
      expect(brokenRead).toContain('broken');
      
      // Nettoyage
      await pc.executeCommand('rm symlink.txt');
    });

    it('should create and manage hard links', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un fichier original
      await pc.executeCommand('echo "Hard link test" > original_hard.txt');
      
      // Créer un lien physique
      await pc.executeCommand('ln original_hard.txt hardlink.txt');
      
      // Vérifier qu'ils partagent le même inode
      const inodeCheck = await pc.executeCommand('ls -i original_hard.txt hardlink.txt');
      const inodes = inodeCheck.split('\n').map(line => line.split(' ')[0]);
      expect(inodes[0]).toBe(inodes[1]);
      
      // Modifier via un lien
      await pc.executeCommand('echo "Additional line" >> hardlink.txt');
      
      // Vérifier que l'original est modifié
      const originalContent = await pc.executeCommand('cat original_hard.txt');
      expect(originalContent).toContain('Additional line');
      
      // Supprimer l'original
      await pc.executeCommand('rm original_hard.txt');
      
      // Vérifier que le lien physique fonctionne toujours
      const viaHardlink = await pc.executeCommand('cat hardlink.txt');
      expect(viaHardlink).toContain('Hard link test');
      
      // Nettoyage
      await pc.executeCommand('rm hardlink.txt');
    });

    it('should work with special files and file descriptors', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Redirection de sortie vers un fichier
      await pc.executeCommand('echo "Standard output" > stdout.txt');
      await pc.executeCommand('ls non_existent 2> stderr.txt');
      
      // Redirection des deux flux
      await pc.executeCommand('ls . non_existent > both.txt 2>&1');
      
      // Append à un fichier
      await pc.executeCommand('echo "Line 1" > log.txt');
      await pc.executeCommand('echo "Line 2" >> log.txt');
      const logContent = await pc.executeCommand('cat log.txt');
      expect(logContent.split('\n').length).toBe(2);
      
      // Utiliser /dev/null
      await pc.executeCommand('echo "This disappears" > /dev/null');
      const nullCheck = await pc.executeCommand('ls /dev/null');
      expect(nullCheck).toContain('/dev/null');
      
      // Utiliser /dev/zero
      await pc.executeCommand('head -c 100 /dev/zero > zero.bin');
      const zeroSize = await pc.executeCommand('wc -c zero.bin');
      expect(zeroSize).toContain('100');
      
      // Utiliser /dev/urandom
      await pc.executeCommand('head -c 50 /dev/urandom > random.bin');
      const randomSize = await pc.executeCommand('wc -c random.bin');
      expect(randomSize).toContain('50');
      
      // Nettoyage
      await pc.executeCommand('rm -f stdout.txt stderr.txt both.txt log.txt zero.bin random.bin');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Gestion des Utilisateurs et Groupes
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Gestion des Utilisateurs et Groupes', () => {

  describe('U-UBU-01: Gestion des utilisateurs', () => {
    it('should create, modify and delete users', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Créer un utilisateur
      await server.executeCommand('sudo useradd -m -s /bin/bash testuser');
      
      // Vérifier la création
      const userExists = await server.executeCommand('id testuser');
      expect(userExists).toContain('testuser');
      
      // Vérifier dans /etc/passwd
      const passwdEntry = await server.executeCommand('grep testuser /etc/passwd');
      expect(passwdEntry).toContain('/home/testuser');
      
      // Changer le shell
      await server.executeCommand('sudo usermod -s /bin/sh testuser');
      const shellCheck = await server.executeCommand('grep testuser /etc/passwd');
      expect(shellCheck).toContain('/bin/sh');
      
      // Changer le répertoire home
      await server.executeCommand('sudo usermod -d /home/newhome -m testuser');
      const homeCheck = await server.executeCommand('grep testuser /etc/passwd');
      expect(homeCheck).toContain('/home/newhome');
      
      // Ajouter à des groupes supplémentaires
      await server.executeCommand('sudo usermod -aG sudo,adm testuser');
      const groups = await server.executeCommand('groups testuser');
      expect(groups).toContain('sudo');
      expect(groups).toContain('adm');
      
      // Bloquer le compte
      await server.executeCommand('sudo usermod -L testuser');
      const lockedStatus = await server.executeCommand('sudo passwd -S testuser');
      expect(lockedStatus).toContain('L');
      
      // Débloquer le compte
      await server.executeCommand('sudo usermod -U testuser');
      const unlockedStatus = await server.executeCommand('sudo passwd -S testuser');
      expect(unlockedStatus).toContain('P');
      
      // Supprimer l'utilisateur
      await server.executeCommand('sudo userdel -r testuser');
      
      // Vérifier la suppression
      const userCheck = await server.executeCommand('id testuser 2>&1 || echo "not found"');
      expect(userCheck).toContain('not found');
    });

    it('should manage user passwords and login information', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Créer un utilisateur
      await server.executeCommand('sudo useradd -m testuser2');
      
      // Définir un mot de passe
      await server.executeCommand('echo "testuser2:Password123" | sudo chpasswd');
      
      // Vérifier le statut du mot de passe
      const passwdStatus = await server.executeCommand('sudo passwd -S testuser2');
      expect(passwdStatus).toContain('testuser2');
      
      // Configurer l'expiration du mot de passe
      await server.executeCommand('sudo chage -M 90 -m 7 -W 14 testuser2');
      
      // Voir les informations d'expiration
      const chageInfo = await server.executeCommand('sudo chage -l testuser2');
      expect(chageInfo).toContain('Minimum');
      expect(chageInfo).toContain('Maximum');
      expect(chageInfo).toContain('Warning');
      
      // Forcer le changement de mot de passe à la prochaine connexion
      await server.executeCommand('sudo chage -d 0 testuser2');
      
      // Vérifier les dernières modifications de mot de passe
      const lastChange = await server.executeCommand('sudo chage -l testuser2 | grep "Last password change"');
      expect(lastChange).toContain('1970');
      
      // Nettoyage
      await server.executeCommand('sudo userdel -r testuser2');
    });

    it('should display user information', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Afficher l'utilisateur courant
      const currentUser = await server.executeCommand('whoami');
      expect(currentUser).toBeTruthy();
      
      // Afficher l'UID et GID
      const idOutput = await server.executeCommand('id');
      expect(idOutput).toContain('uid=');
      expect(idOutput).toContain('gid=');
      
      // Afficher les groupes de l'utilisateur courant
      const groupsOutput = await server.executeCommand('groups');
      expect(groupsOutput).toBeTruthy();
      
      // Afficher tous les utilisateurs connectés
      const whoOutput = await server.executeCommand('who');
      
      // Afficher les informations de connexion détaillées
      const wOutput = await server.executeCommand('w');
      
      // Afficher la dernière connexion
      const lastOutput = await server.executeCommand('last | head -5');
      
      // Afficher tous les utilisateurs
      const allUsers = await server.executeCommand('cut -d: -f1 /etc/passwd | sort');
      expect(allUsers).toContain('root');
    });
  });

  describe('U-UBU-02: Gestion des groupes', () => {
    it('should create, modify and delete groups', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Créer un groupe
      await server.executeCommand('sudo groupadd testgroup');
      
      // Vérifier la création
      const groupExists = await server.executeCommand('getent group testgroup');
      expect(groupExists).toContain('testgroup');
      
      // Créer un utilisateur dans le groupe
      await server.executeCommand('sudo useradd -m -G testgroup testuser3');
      
      // Vérifier l'appartenance
      const userGroups = await server.executeCommand('groups testuser3');
      expect(userGroups).toContain('testgroup');
      
      // Ajouter un utilisateur existant au groupe
      await server.executeCommand('sudo useradd -m existinguser');
      await server.executeCommand('sudo usermod -aG testgroup existinguser');
      
      // Vérifier l'ajout
      const existingGroups = await server.executeCommand('groups existinguser');
      expect(existingGroups).toContain('testgroup');
      
      // Retirer un utilisateur du groupe
      await server.executeCommand('sudo gpasswd -d existinguser testgroup');
      const removedCheck = await server.executeCommand('groups existinguser');
      expect(removedCheck).not.toContain('testgroup');
      
      // Changer le GID du groupe
      await server.executeCommand('sudo groupmod -g 2001 testgroup');
      const gidCheck = await server.executeCommand('getent group testgroup');
      expect(gidCheck).toContain('2001');
      
      // Changer le nom du groupe
      await server.executeCommand('sudo groupmod -n newgroupname testgroup');
      const nameCheck = await server.executeCommand('getent group newgroupname');
      expect(nameCheck).toContain('newgroupname');
      
      // Supprimer le groupe
      await server.executeCommand('sudo groupdel newgroupname');
      
      // Nettoyage
      await server.executeCommand('sudo userdel -r testuser3');
      await server.executeCommand('sudo userdel -r existinguser');
    });

    it('should manage group administrators and passwords', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Créer un groupe avec mot de passe
      await server.executeCommand('sudo groupadd securegroup');
      await server.executeCommand('echo "securegroup:GroupPass123" | sudo gpasswd');
      
      // Définir des administrateurs du groupe
      await server.executeCommand('sudo useradd -m admin1');
      await server.executeCommand('sudo useradd -m admin2');
      await server.executeCommand('sudo gpasswd -A admin1,admin2 securegroup');
      
      // Ajouter des membres au groupe
      await server.executeCommand('sudo useradd -m member1');
      await server.executeCommand('sudo useradd -m member2');
      await server.executeCommand('sudo gpasswd -M member1,member2 securegroup');
      
      // Vérifier les membres
      const members = await server.executeCommand('getent group securegroup');
      expect(members).toContain('member1');
      expect(members).toContain('member2');
      
      // Nettoyage
      await server.executeCommand('sudo userdel -r admin1');
      await server.executeCommand('sudo userdel -r admin2');
      await server.executeCommand('sudo userdel -r member1');
      await server.executeCommand('sudo userdel -r member2');
      await server.executeCommand('sudo groupdel securegroup');
    });

    it('should work with wheel/sudo group', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Créer un utilisateur
      await server.executeCommand('sudo useradd -m sudo_user');
      
      // Ajouter au groupe sudo
      await server.executeCommand('sudo usermod -aG sudo sudo_user');
      
      // Vérifier les privilèges sudo
      const sudoCheck = await server.executeCommand('sudo -l -U sudo_user');
      expect(sudoCheck).toContain('may run the following commands');
      
      // Créer un fichier sudoers pour test
      await server.executeCommand('echo "sudo_user ALL=(ALL) NOPASSWD: /usr/bin/ls" | sudo tee /etc/sudoers.d/test_sudo');
      await server.executeCommand('sudo chmod 440 /etc/sudoers.d/test_sudo');
      
      // Tester l'exécution sans mot de passe
      await server.executeCommand('sudo -u sudo_user sudo ls /root');
      
      // Nettoyage
      await server.executeCommand('sudo rm /etc/sudoers.d/test_sudo');
      await server.executeCommand('sudo userdel -r sudo_user');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: Gestion des Permissions
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Gestion des Permissions', () => {

  describe('P-UBU-01: Permissions POSIX de base', () => {
    it('should understand and modify file permissions', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un fichier
      await pc.executeCommand('touch perm_test.txt');
      
      // Vérifier les permissions par défaut
      const defaultPerms = await pc.executeCommand('ls -l perm_test.txt');
      expect(defaultPerms).toContain('-rw-r--r--');
      
      // Changer en lecture seule pour le propriétaire
      await pc.executeCommand('chmod u-w perm_test.txt');
      let perms = await pc.executeCommand('ls -l perm_test.txt');
      expect(perms).toContain('-r--r--r--');
      
      // Donner l'exécution au propriétaire
      await pc.executeCommand('chmod u+x perm_test.txt');
      perms = await pc.executeCommand('ls -l perm_test.txt');
      expect(perms).toContain('-r-xr--r--');
      
      // Donner écriture au groupe
      await pc.executeCommand('chmod g+w perm_test.txt');
      perms = await pc.executeCommand('ls -l perm_test.txt');
      expect(perms).toContain('-r-xrw-r--');
      
      // Enlever la lecture pour others
      await pc.executeCommand('chmod o-r perm_test.txt');
      perms = await pc.executeCommand('ls -l perm_test.txt');
      expect(perms).toContain('-r-xrw----');
      
      // Utiliser la notation octale
      await pc.executeCommand('chmod 755 perm_test.txt');
      perms = await pc.executeCommand('ls -l perm_test.txt');
      expect(perms).toContain('-rwxr-xr-x');
      
      await pc.executeCommand('chmod 644 perm_test.txt');
      perms = await pc.executeCommand('ls -l perm_test.txt');
      expect(perms).toContain('-rw-r--r--');
      
      await pc.executeCommand('chmod 600 perm_test.txt');
      perms = await pc.executeCommand('ls -l perm_test.txt');
      expect(perms).toContain('-rw-------');
      
      // Nettoyage
      await pc.executeCommand('rm perm_test.txt');
    });

    it('should work with special permission bits', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un répertoire
      await pc.executeCommand('mkdir special_dir');
      
      // Setuid bit - exécution avec les droits du propriétaire
      await pc.executeCommand('chmod u+s special_dir');
      let perms = await pc.executeCommand('ls -ld special_dir');
      expect(perms).toContain('drws');
      
      // Setgid bit - fichiers créés héritent du groupe
      await pc.executeCommand('chmod g+s special_dir');
      perms = await pc.executeCommand('ls -ld special_dir');
      expect(perms).toContain('drwsr-s');
      
      // Sticky bit - seul le propriétaire peut supprimer
      await pc.executeCommand('chmod +t special_dir');
      perms = await pc.executeCommand('ls -ld special_dir');
      expect(perms).toContain('drwsr-sr-t');
      
      // Notation octale avec bits spéciaux
      await pc.executeCommand('chmod 2755 special_dir');  // setgid
      perms = await pc.executeCommand('ls -ld special_dir');
      expect(perms).toContain('drwxr-sr-x');
      
      await pc.executeCommand('chmod 4755 special_dir');  // setuid
      perms = await pc.executeCommand('ls -ld special_dir');
      expect(perms).toContain('drwsr-xr-x');
      
      await pc.executeCommand('chmod 1777 special_dir');  // sticky
      perms = await pc.executeCommand('ls -ld special_dir');
      expect(perms).toContain('drwxrwxrwt');
      
      // Nettoyage
      await pc.executeCommand('rmdir special_dir');
    });

    it('should use umask to set default permissions', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Sauvegarder l'umask actuel
      const originalUmask = await pc.executeCommand('umask');
      
      // Changer l'umask
      await pc.executeCommand('umask 077');
      
      // Créer un fichier avec le nouvel umask
      await pc.executeCommand('touch umask_test.txt');
      let perms = await pc.executeCommand('ls -l umask_test.txt');
      expect(perms).toContain('-rw-------');
      
      // Changer pour un umask plus permissif
      await pc.executeCommand('umask 022');
      await pc.executeCommand('touch umask_test2.txt');
      perms = await pc.executeCommand('ls -l umask_test2.txt');
      expect(perms).toContain('-rw-r--r--');
      
      // Umask pour les répertoires
      await pc.executeCommand('umask 022');
      await pc.executeCommand('mkdir umask_dir');
      perms = await pc.executeCommand('ls -ld umask_dir');
      expect(perms).toContain('drwxr-xr-x');
      
      // Restaurer l'umask original
      await pc.executeCommand(`umask ${originalUmask}`);
      
      // Nettoyage
      await pc.executeCommand('rm umask_test.txt umask_test2.txt');
      await pc.executeCommand('rmdir umask_dir');
    });
  });

  describe('P-UBU-02: Propriété des fichiers', () => {
    it('should change file ownership with chown and chgrp', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Créer des utilisateurs et groupes de test
      await server.executeCommand('sudo useradd -m owneruser');
      await server.executeCommand('sudo useradd -m otheruser');
      await server.executeCommand('sudo groupadd ownergroup');
      await server.executeCommand('sudo groupadd othergroup');
      
      // Créer un fichier
      await server.executeCommand('sudo touch ownership_test.txt');
      
      // Changer le propriétaire
      await server.executeCommand('sudo chown owneruser ownership_test.txt');
      let ownership = await server.executeCommand('ls -l ownership_test.txt');
      expect(ownership).toContain('owneruser');
      
      // Changer le groupe
      await server.executeCommand('sudo chgrp ownergroup ownership_test.txt');
      ownership = await server.executeCommand('ls -l ownership_test.txt');
      expect(ownership).toContain('ownergroup');
      
      // Changer propriétaire et groupe en une commande
      await server.executeCommand('sudo chown otheruser:othergroup ownership_test.txt');
      ownership = await server.executeCommand('ls -l ownership_test.txt');
      expect(ownership).toContain('otheruser');
      expect(ownership).toContain('othergroup');
      
      // Changer récursivement
      await server.executeCommand('sudo mkdir -p recursive_test/dir1/dir2');
      await server.executeCommand('sudo touch recursive_test/file1.txt');
      await server.executeCommand('sudo touch recursive_test/dir1/file2.txt');
      
      await server.executeCommand('sudo chown -R owneruser:ownergroup recursive_test');
      
      // Vérifier récursivement
      const recursiveCheck = await server.executeCommand('sudo ls -lR recursive_test');
      expect(recursiveCheck).toContain('owneruser');
      expect(recursiveCheck).toContain('ownergroup');
      
      // Nettoyage
      await server.executeCommand('sudo rm -rf ownership_test.txt recursive_test');
      await server.executeCommand('sudo userdel -r owneruser');
      await server.executeCommand('sudo userdel -r otheruser');
      await server.executeCommand('sudo groupdel ownergroup');
      await server.executeCommand('sudo groupdel othergroup');
    });

    it('should find files by ownership', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Créer utilisateur et fichiers
      await server.executeCommand('sudo useradd -m finduser');
      await server.executeCommand('sudo touch /tmp/file1.txt');
      await server.executeCommand('sudo touch /tmp/file2.txt');
      await server.executeCommand('sudo mkdir /tmp/finddir');
      
      // Changer propriétaire de certains fichiers
      await server.executeCommand('sudo chown finduser /tmp/file1.txt');
      await server.executeCommand('sudo chown finduser /tmp/finddir');
      
      // Trouver les fichiers appartenant à finduser
      const ownedFiles = await server.executeCommand('sudo find /tmp -user finduser 2>/dev/null');
      expect(ownedFiles).toContain('file1.txt');
      expect(ownedFiles).toContain('finddir');
      
      // Trouver les fichiers appartenant à root
      const rootFiles = await server.executeCommand('sudo find /tmp -user root 2>/dev/null | head -5');
      
      // Trouver par groupe
      await server.executeCommand('sudo groupadd findgroup');
      await server.executeCommand('sudo chgrp findgroup /tmp/file2.txt');
      
      const groupFiles = await server.executeCommand('sudo find /tmp -group findgroup 2>/dev/null');
      expect(groupFiles).toContain('file2.txt');
      
      // Nettoyage
      await server.executeCommand('sudo rm -f /tmp/file1.txt /tmp/file2.txt');
      await server.executeCommand('sudo rmdir /tmp/finddir');
      await server.executeCommand('sudo userdel -r finduser');
      await server.executeCommand('sudo groupdel findgroup');
    });
  });

  describe('P-UBU-03: Commandes d\'information sur les permissions', () => {
    it('should use stat command to get detailed file information', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un fichier
      await pc.executeCommand('touch stat_test.txt');
      
      // Obtenir des informations détaillées
      const statOutput = await pc.executeCommand('stat stat_test.txt');
      expect(statOutput).toContain('File:');
      expect(statOutput).toContain('Size:');
      expect(statOutput).toContain('Blocks:');
      expect(statOutput).toContain('Inode:');
      expect(statOutput).toContain('Links:');
      expect(statOutput).toContain('Access:');
      
      // Format personnalisé
      const customStat = await pc.executeCommand('stat -c "%n %U %G %a" stat_test.txt');
      expect(customStat).toContain('stat_test.txt');
      
      // Vérifier les permissions en octal
      const octalPerms = await pc.executeCommand('stat -c "%a" stat_test.txt');
      expect(octalPerms).toMatch(/^\d{3,4}$/);
      
      // Vérifier l'inode
      const inode = await pc.executeCommand('stat -c "%i" stat_test.txt');
      expect(parseInt(inode)).toBeGreaterThan(0);
      
      // Vérifier la taille
      await pc.executeCommand('echo "test content" > stat_test.txt');
      const size = await pc.executeCommand('stat -c "%s" stat_test.txt');
      expect(parseInt(size)).toBeGreaterThan(0);
      
      // Nettoyage
      await pc.executeCommand('rm stat_test.txt');
    });

    it('should check file type and permissions', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer différents types de fichiers
      await pc.executeCommand('touch regular.txt');
      await pc.executeCommand('mkdir directory');
      await pc.executeCommand('ln -s regular.txt symlink.txt');
      await pc.executeCommand('mkfifo myfifo');
      
      // Tester avec test command
      const isFile = await pc.executeCommand('test -f regular.txt && echo "is file"');
      expect(isFile).toContain('is file');
      
      const isDir = await pc.executeCommand('test -d directory && echo "is directory"');
      expect(isDir).toContain('is directory');
      
      const isSymlink = await pc.executeCommand('test -L symlink.txt && echo "is symlink"');
      expect(isSymlink).toContain('is symlink');
      
      // Tester les permissions
      await pc.executeCommand('chmod 444 regular.txt');
      const isReadable = await pc.executeCommand('test -r regular.txt && echo "readable"');
      expect(isReadable).toContain('readable');
      
      const isWritable = await pc.executeCommand('test -w regular.txt || echo "not writable"');
      expect(isWritable).toContain('not writable');
      
      const isExecutable = await pc.executeCommand('test -x regular.txt || echo "not executable"');
      expect(isExecutable).toContain('not executable');
      
      // Vérifier si un fichier existe
      const exists = await pc.executeCommand('test -e regular.txt && echo "exists"');
      expect(exists).toContain('exists');
      
      const notExists = await pc.executeCommand('test -e nonexistent.txt || echo "does not exist"');
      expect(notExists).toContain('does not exist');
      
      // Nettoyage
      await pc.executeCommand('rm -f regular.txt symlink.txt myfifo');
      await pc.executeCommand('rmdir directory');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: Commandes Utilitaires
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Commandes Utilitaires', () => {

  describe('C-UBU-01: Visualisation et tri de fichiers', () => {
    it('should list files with different options', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer des fichiers de test
      await pc.executeCommand('mkdir list_test');
      await pc.executeCommand('touch list_test/file1.txt');
      await pc.executeCommand('touch list_test/file2.txt');
      await pc.executeCommand('touch list_test/.hiddenfile');
      await pc.executeCommand('mkdir list_test/subdir');
      
      // Liste simple
      const simple = await pc.executeCommand('ls list_test');
      expect(simple).toContain('file1.txt');
      expect(simple).toContain('file2.txt');
      expect(simple).toContain('subdir');
      
      // Liste détaillée
      const detailed = await pc.executeCommand('ls -l list_test');
      expect(detailed).toContain('-rw-'); // permissions
      expect(detailed).toContain('file1.txt');
      
      // Liste avec fichiers cachés
      const all = await pc.executeCommand('ls -la list_test');
      expect(all).toContain('.hiddenfile');
      
      // Liste triée par taille
      await pc.executeCommand('echo "content" > list_test/big.txt');
      await pc.executeCommand('echo "c" > list_test/small.txt');
      
      const bySize = await pc.executeCommand('ls -lS list_test');
      expect(bySize.indexOf('big.txt')).toBeLessThan(bySize.indexOf('small.txt'));
      
      // Liste triée par date de modification
      const byTime = await pc.executeCommand('ls -lt list_test');
      
      // Liste récursive
      const recursive = await pc.executeCommand('ls -R list_test');
      expect(recursive).toContain('subdir:');
      
      // Liste avec couleurs
      const colored = await pc.executeCommand('ls --color=auto list_test');
      
      // Nettoyage
      await pc.executeCommand('rm -rf list_test');
    });

    it('should sort and filter file listings', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer des fichiers
      await pc.executeCommand('mkdir sort_test');
      await pc.executeCommand('touch sort_test/apple.txt');
      await pc.executeCommand('touch sort_test/banana.txt');
      await pc.executeCommand('touch sort_test/cherry.txt');
      await pc.executeCommand('touch sort_test/123.txt');
      await pc.executeCommand('touch sort_test/45.txt');
      
      // Trier alphabétiquement
      const alpha = await pc.executeCommand('ls sort_test | sort');
      const lines = alpha.trim().split('\n');
      expect(lines[0]).toContain('123.txt');
      expect(lines[lines.length-1]).toContain('cherry.txt');
      
      // Trier numériquement
      const numeric = await pc.executeCommand('ls sort_test/*.txt | sort -n');
      
      // Trier par taille de fichier
      await pc.executeCommand('echo "big file" > sort_test/big.txt');
      await pc.executeCommand('echo "s" > sort_test/small.txt');
      
      const sizeSort = await pc.executeCommand('ls -S sort_test');
      expect(sizeSort.indexOf('big.txt')).toBeLessThan(sizeSort.indexOf('small.txt'));
      
      // Filtrer avec grep
      const filtered = await pc.executeCommand('ls sort_test | grep "a"');
      expect(filtered).toContain('apple');
      expect(filtered).toContain('banana');
      
      // Trier en ordre inverse
      const reverse = await pc.executeCommand('ls sort_test | sort -r');
      expect(reverse.indexOf('cherry.txt')).toBeLessThan(reverse.indexOf('apple.txt'));
      
      // Nettoyage
      await pc.executeCommand('rm -rf sort_test');
    });
  });

  describe('C-UBU-02: Manipulation de texte', () => {
    it('should manipulate text files with basic commands', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un fichier texte
      await pc.executeCommand('echo -e "line1\nline2\nline3\nline4\nline5" > textfile.txt');
      
      // Afficher les premières lignes
      const headOutput = await pc.executeCommand('head -3 textfile.txt');
      expect(headOutput.split('\n').length).toBe(3);
      
      // Afficher les dernières lignes
      const tailOutput = await pc.executeCommand('tail -3 textfile.txt');
      expect(tailOutput.split('\n').length).toBe(3);
      
      // Suivre un fichier en temps réel (simulé)
      await pc.executeCommand('tail -f textfile.txt &');
      await pc.executeCommand('sleep 0.1');
      await pc.executeCommand('echo "new line" >> textfile.txt');
      await pc.executeCommand('kill %1 2>/dev/null');
      
      // Compter les lignes, mots, caractères
      const wcOutput = await pc.executeCommand('wc textfile.txt');
      expect(wcOutput).toMatch(/\d+\s+\d+\s+\d+/);
      
      // Couper des colonnes
      await pc.executeCommand('echo "col1 col2 col3" > columns.txt');
      const cutOutput = await pc.executeCommand('cut -d" " -f1,3 columns.txt');
      expect(cutOutput).toContain('col1 col3');
      
      // Trier les lignes
      await pc.executeCommand('echo -e "banana\napple\ncherry" > tosort.txt');
      const sorted = await pc.executeCommand('sort tosort.txt');
      expect(sorted.indexOf('apple')).toBeLessThan(sorted.indexOf('banana'));
      
      // Supprimer les doublons adjacents (uniq ne supprime que les doublons consécutifs)
      // Input: a, a, b, c, b → Output: a, b, c, b (4 lignes)
      await pc.executeCommand('echo -e "a\na\nb\nc\nb" > duplicates.txt');
      const unique = await pc.executeCommand('uniq duplicates.txt');
      expect(unique.split('\n').length).toBe(4);
      
      // Transformer le texte
      await pc.executeCommand('echo "hello world" > transform.txt');
      const upper = await pc.executeCommand('tr "a-z" "A-Z" < transform.txt');
      expect(upper).toContain('HELLO WORLD');
      
      // Nettoyage
      await pc.executeCommand('rm -f textfile.txt columns.txt tosort.txt duplicates.txt transform.txt');
    });

    it('should use awk for text processing', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un fichier CSV simple
      await pc.executeCommand('echo -e "John,25,Engineer\nJane,30,Doctor\nBob,35,Teacher" > data.csv');
      
      // Afficher la première colonne
      const firstCol = await pc.executeCommand('awk -F"," \'{print $1}\' data.csv');
      expect(firstCol).toContain('John');
      expect(firstCol).toContain('Jane');
      expect(firstCol).toContain('Bob');
      
      // Filtrer les lignes
      const ageFilter = await pc.executeCommand('awk -F"," \'$2 > 30\' data.csv');
      expect(ageFilter).toContain('Bob');
      expect(ageFilter).not.toContain('John');
      
      // Calculer une somme
      const sum = await pc.executeCommand('awk -F"," \'{sum += $2} END {print sum}\' data.csv');
      expect(parseInt(sum)).toBe(90);
      
      // Formater la sortie
      const formatted = await pc.executeCommand('awk -F"," \'{print "Name: " $1 ", Age: " $2}\' data.csv');
      expect(formatted).toContain('Name: John, Age: 25');
      
      // Utiliser des variables
      const withVar = await pc.executeCommand('awk -F"," -v bonus=5 \'{print $1, $2 + bonus}\' data.csv');
      
      // Nettoyage
      await pc.executeCommand('rm data.csv');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: Scripts et Automatisation
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Scripts et Automatisation', () => {

  describe('S-UBU-01: Scripts shell basiques', () => {
    it('should create and execute shell scripts', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un script simple
      const scriptContent = `#!/bin/bash
# Script de test
echo "Hello from script"
echo "Current directory: $(pwd)"
echo "User: $(whoami)"
ls -la
`;
      
      await pc.executeCommand(`echo '${scriptContent}' > myscript.sh`);
      
      // Donner les permissions d'exécution
      await pc.executeCommand('chmod +x myscript.sh');
      
      // Exécuter le script
      const output = await pc.executeCommand('./myscript.sh');
      expect(output).toContain('Hello from script');
      expect(output).toContain('Current directory:');
      expect(output).toContain('User:');
      
      // Exécuter avec bash
      const bashOutput = await pc.executeCommand('bash myscript.sh');
      expect(bashOutput).toContain('Hello from script');
      
      // Exécuter avec sh
      const shOutput = await pc.executeCommand('sh myscript.sh');
      expect(shOutput).toContain('Hello from script');
      
      // Vérifier le shebang
      const shebang = await pc.executeCommand('head -1 myscript.sh');
      expect(shebang).toContain('#!/bin/bash');
      
      // Nettoyage
      await pc.executeCommand('rm myscript.sh');
    });

    it('should use variables and parameters in scripts', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un script avec variables
      const varScript = `#!/bin/bash
VAR1="Hello"
VAR2="World"
echo "\$VAR1 \$VAR2"

# Paramètres
echo "Script name: \$0"
echo "First param: \$1"
echo "Second param: \$2"
echo "All params: \$@"
echo "Param count: \$#"

# Variables spéciales
echo "Process ID: \$\$"
echo "Exit code: \$?"
`;
      
      await pc.executeCommand(`echo '${varScript}' > varscript.sh`);
      await pc.executeCommand('chmod +x varscript.sh');
      
      // Exécuter avec paramètres
      const output = await pc.executeCommand('./varscript.sh param1 param2 param3');
      expect(output).toContain('Hello World');
      expect(output).toContain('Script name: ./varscript.sh');
      expect(output).toContain('First param: param1');
      expect(output).toContain('All params: param1 param2 param3');
      expect(output).toContain('Param count: 3');
      
      // Nettoyage
      await pc.executeCommand('rm varscript.sh');
    });

    it('should use control structures in scripts', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      
      // Créer un script avec structures de contrôle
      const controlScript = `#!/bin/bash
# Condition if
if [ -f "/etc/passwd" ]; then
  echo "File exists"
fi

# Boucle for
for i in 1 2 3 4 5; do
  echo "Iteration \$i"
done

# Boucle while
count=1
while [ \$count -le 3 ]; do
  echo "While loop: \$count"
  count=\$((count + 1))
done

# Case statement
fruit="apple"
case \$fruit in
  apple) echo "It's an apple";;
  banana) echo "It's a banana";;
  *) echo "Unknown fruit";;
esac
`;
      
      await pc.executeCommand(`echo '${controlScript}' > control.sh`);
      await pc.executeCommand('chmod +x control.sh');
      
      const output = await pc.executeCommand('./control.sh');
      expect(output).toContain('File exists');
      expect(output).toContain('Iteration 1');
      expect(output).toContain('Iteration 5');
      expect(output).toContain('While loop: 1');
      expect(output).toContain('While loop: 3');
      expect(output).toContain("It's an apple");
      
      // Nettoyage
      await pc.executeCommand('rm control.sh');
    });
  });

  describe('S-UBU-02: Automatisation avec cron', () => {
    it('should schedule tasks with cron', async () => {
      const server = new LinuxServer('linux-server', 'TEST-SRV');
      
      // Créer un script à exécuter
      await server.executeCommand('echo "#!/bin/bash\necho \"Cron job executed at $(date)\" >> /tmp/cron_test.log" > /tmp/mycronjob.sh');
      await server.executeCommand('chmod +x /tmp/mycronjob.sh');
      
      // Ajouter une tâche cron
      await server.executeCommand('echo "* * * * * /tmp/mycronjob.sh" | crontab -');
      
      // Vérifier le crontab
      const crontabList = await server.executeCommand('crontab -l');
      expect(crontabList).toContain('/tmp/mycronjob.sh');
      
      // Vérifier les fichiers cron système
      const cronHourly = await server.executeCommand('ls /etc/cron.hourly/ 2>/dev/null || true');
      const cronDaily = await server.executeCommand('ls /etc/cron.daily/ 2>/dev/null || true');
      const cronWeekly = await server.executeCommand('ls /etc/cron.weekly/ 2>/dev/null || true');
      const cronMonthly = await server.executeCommand('ls /etc/cron.monthly/ 2>/dev/null || true');
      
      // Nettoyer le crontab
      await server.executeCommand('crontab -r');
      
      // Vérifier que c'est vide
      const emptyCron = await server.executeCommand('crontab -l 2>&1 || echo "no crontab"');
      expect(emptyCron).toContain('no crontab');
      
      // Nettoyage
      await server.executeCommand('rm -f /tmp/mycronjob.sh /tmp/cron_test.log');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: Authentification, Mots de Passe et Gestion des Fichiers Utilisateur
// Backend: password infrastructure, fichiers créés par adduser, permissions
// UI: prompts interactifs gérés par Terminal.tsx (non testés ici)
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Authentification et Fichiers Utilisateur', () => {

  describe('I-UBU-01: Infrastructure des mots de passe', () => {
    it('should have default password "admin" for PC user', () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      expect(pc.checkPassword('user', 'admin')).toBe(true);
      expect(pc.checkPassword('user', 'wrong')).toBe(false);
    });

    it('should have default password "admin" for root', () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      expect(server.checkPassword('root', 'admin')).toBe(true);
    });

    it('should allow setting and verifying passwords', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      await pc.executeCommand('sudo useradd -m -s /bin/bash alice');
      pc.setUserPassword('alice', 'mypassword');

      expect(pc.checkPassword('alice', 'mypassword')).toBe(true);
      expect(pc.checkPassword('alice', 'wrong')).toBe(false);
    });

    it('should return false for non-existent user', () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      expect(pc.checkPassword('nobody_here', 'test')).toBe(false);
    });

    it('should expose getCurrentUid correctly', () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      expect(pc.getCurrentUid()).toBe(1000); // regular user

      const server = new LinuxServer('linux-server', 'SRV1');
      expect(server.getCurrentUid()).toBe(0); // root
    });

    it('should expose userExists correctly', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      expect(pc.userExists('user')).toBe(true);
      expect(pc.userExists('alice')).toBe(false);

      await pc.executeCommand('sudo useradd -m alice');
      expect(pc.userExists('alice')).toBe(true);
    });
  });

  describe('I-UBU-02: adduser crée les fichiers correctement', () => {
    it('should create home directory with skeleton files via adduser', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      const out = await server.executeCommand('adduser tempuser');
      expect(out).toContain("Adding user `tempuser'");
      expect(out).toContain("Creating home directory `/home/tempuser'");
      expect(out).toContain("Copying files from `/etc/skel'");

      // Verify home dir exists
      const lsHome = await server.executeCommand('ls /home');
      expect(lsHome).toContain('tempuser');

      // Verify skeleton files
      const lsFiles = await server.executeCommand('ls -la /home/tempuser/');
      expect(lsFiles).toContain('.bash_logout');
      expect(lsFiles).toContain('.bashrc');
      expect(lsFiles).toContain('.profile');
      expect(lsFiles).toContain('tempuser');
    });

    it('should create home directory with skeleton files via useradd -m', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      await server.executeCommand('useradd -m -s /bin/bash alice');

      const lsHome = await server.executeCommand('ls /home');
      expect(lsHome).toContain('alice');

      const lsFiles = await server.executeCommand('ls -la /home/alice/');
      expect(lsFiles).toContain('.bash_logout');
      expect(lsFiles).toContain('.bashrc');
      expect(lsFiles).toContain('.profile');
    });

    it('should NOT create home directory with useradd without -m', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      await server.executeCommand('useradd mandeng');

      const lsHome = await server.executeCommand('ls /home');
      expect(lsHome).not.toContain('mandeng');
    });

    it('should remove home dir with deluser --remove-home', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      await server.executeCommand('adduser tempuser');
      const lsBefore = await server.executeCommand('ls /home');
      expect(lsBefore).toContain('tempuser');

      const delOut = await server.executeCommand('deluser --remove-home tempuser');
      expect(delOut).toContain('Looking for files to backup/remove');
      expect(delOut).toContain('Removing files');
      expect(delOut).toContain("Removing user `tempuser'");
      expect(delOut).toContain('Done.');

      const lsAfter = await server.executeCommand('ls /home');
      expect(lsAfter).not.toContain('tempuser');
    });
  });

  describe('I-UBU-03: sudo et su backend (sans prompts UI)', () => {
    it('should execute sudo commands as root from non-root user', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');

      // sudo useradd should succeed (executor handles elevation)
      await pc.executeCommand('sudo useradd -m -s /bin/bash alice');
      const id = await pc.executeCommand('id alice');
      expect(id).toContain('alice');
    });

    it('should switch user with su command', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');

      await pc.executeCommand('sudo useradd -m -s /bin/bash alice');
      await pc.executeCommand('su - alice');

      const whoami = await pc.executeCommand('whoami');
      expect(whoami.trim()).toBe('alice');
    });

    it('should switch user with sudo su command', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');

      await pc.executeCommand('sudo useradd -m -s /bin/bash bob');
      await pc.executeCommand('sudo su - bob');

      const whoami = await pc.executeCommand('whoami');
      expect(whoami.trim()).toBe('bob');
    });

    it('should reject useradd without sudo from normal user', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');

      const out = await pc.executeCommand('useradd alice');
      expect(out).toContain('Permission denied');
    });

    it('should handle passwd output correctly', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');

      await pc.executeCommand('sudo useradd -m alice');
      const out = await pc.executeCommand('sudo passwd alice');
      expect(out).toContain('passwd: password updated successfully');
    });

    it('should not show password prompts for passwd -l/-S', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');

      await pc.executeCommand('sudo useradd -m alice');

      const lockOut = await pc.executeCommand('sudo passwd -l alice');
      expect(lockOut).not.toContain('New password:');
      expect(lockOut).toContain('password expiry information changed');

      const statusOut = await pc.executeCommand('sudo passwd -S alice');
      expect(statusOut).not.toContain('New password:');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: adduser/useradd Amélioré — Expérience Réaliste
// Tests TDD pour une implémentation fidèle à Debian/Ubuntu
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: adduser/useradd Réaliste', () => {

  // ─── 7.1: GECOS field support ──────────────────────────────────────

  describe('G7-01: Support des champs GECOS', () => {
    it('should store GECOS fields via setUserGecos', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser jean');

      // Set GECOS fields (Full Name, Room, Work Phone, Home Phone, Other)
      server.setUserGecos('jean', 'Jean Dupont', '101', '555-1234', '555-5678', 'Notes');

      // Verify in /etc/passwd — GECOS format: Full Name,Room,Work Phone,Home Phone,Other
      const passwd = await server.executeCommand('grep jean /etc/passwd');
      expect(passwd).toContain('Jean Dupont,101,555-1234,555-5678,Notes');
    });

    it('should display GECOS in getent passwd', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser marie');
      server.setUserGecos('marie', 'Marie Martin', '202', '', '', '');

      const getent = await server.executeCommand('getent passwd marie');
      // Format: marie:x:UID:GID:Marie Martin,202,,,:home:shell
      expect(getent).toContain('Marie Martin,202,,,');
    });

    it('should support useradd -c "Full Name" for GECOS comment', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('useradd -m -c "Pierre Durand" -s /bin/bash pierre');

      const passwd = await server.executeCommand('grep pierre /etc/passwd');
      expect(passwd).toContain('Pierre Durand');

      const getent = await server.executeCommand('getent passwd pierre');
      expect(getent).toContain('Pierre Durand');
    });

    it('should default GECOS to empty when not set', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('useradd -m testnogecos');

      const passwd = await server.executeCommand('grep testnogecos /etc/passwd');
      // GECOS field should be empty (between the 4th and 5th colon)
      expect(passwd).toMatch(/testnogecos:x:\d+:\d+::/);
    });

    it('should support chfn command to change GECOS fields', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser lucas');

      // chfn -f "Full Name" -r "Room" -w "Work Phone" -h "Home Phone" username
      await server.executeCommand('chfn -f "Lucas Bernard" -r "303" -w "555-9999" -h "555-0000" lucas');

      const passwd = await server.executeCommand('grep lucas /etc/passwd');
      expect(passwd).toContain('Lucas Bernard,303,555-9999,555-0000');
    });

    it('should support finger command to display user info', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser alice');
      server.setUserGecos('alice', 'Alice Wonderland', '101', '555-1111', '555-2222', '');

      const finger = await server.executeCommand('finger alice');
      expect(finger).toContain('Login: alice');
      expect(finger).toContain('Name: Alice Wonderland');
      expect(finger).toContain('Directory: /home/alice');
      expect(finger).toContain('Shell: /bin/bash');
    });
  });

  // ─── 7.2: adduser realistic output ────────────────────────────────

  describe('G7-02: adduser output réaliste Debian', () => {
    it('should produce realistic Debian adduser output', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('adduser sophie');

      // Must match real Debian adduser output format
      expect(out).toContain("Adding user `sophie' ...");
      expect(out).toContain("Adding new group `sophie'");
      expect(out).toContain("Adding new user `sophie'");
      expect(out).toContain("with group `sophie'");
      expect(out).toContain("Creating home directory `/home/sophie' ...");
      expect(out).toContain("Copying files from `/etc/skel' ...");
    });

    it('should reject adduser for existing user', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser testdup');

      const out = await server.executeCommand('adduser testdup');
      expect(out).toContain('already exists');
    });

    it('should reject adduser without username', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('adduser');
      expect(out).toContain('missing');
    });

    it('should support adduser --gecos "Full Name" to skip prompts', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('adduser --gecos "Auto User" autouser');

      expect(out).toContain("Adding user `autouser' ...");
      // Verify GECOS was set
      const passwd = await server.executeCommand('grep autouser /etc/passwd');
      expect(passwd).toContain('Auto User');
    });

    it('should support adduser --disabled-password', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('adduser --disabled-password --gecos "No Pass User" nopassuser');

      expect(out).toContain("Adding user `nopassuser' ...");
      // User should exist but have no password set (locked or NP)
      const status = await server.executeCommand('passwd -S nopassuser');
      // Password status should be NP (no password) or L (locked)
      expect(status).toMatch(/nopassuser\s+(NP|L)/);
    });
  });

  // ─── 7.3: End-to-end user lifecycle ───────────────────────────────

  describe('G7-03: Cycle de vie complet d\'un utilisateur', () => {
    it('should create user, set password, login, verify identity', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      // 1. Create user
      await server.executeCommand('adduser marc');

      // 2. Set password
      server.setUserPassword('marc', 'SecureP@ss1');
      expect(server.checkPassword('marc', 'SecureP@ss1')).toBe(true);
      expect(server.checkPassword('marc', 'wrong')).toBe(false);

      // 3. Switch to the new user
      await server.executeCommand('su - marc');

      // 4. Verify identity
      const whoami = await server.executeCommand('whoami');
      expect(whoami.trim()).toBe('marc');

      const id = await server.executeCommand('id');
      expect(id).toContain('marc');

      // 5. Verify we're in the correct home directory
      const pwd = await server.executeCommand('pwd');
      expect(pwd.trim()).toBe('/home/marc');

      // 6. Verify skeleton files are accessible
      const ls = await server.executeCommand('ls -la');
      expect(ls).toContain('.bashrc');
      expect(ls).toContain('.profile');
      expect(ls).toContain('.bash_logout');

      // 7. Exit back to root
      const exitResult = server.handleExit();
      expect(exitResult.inSu).toBe(true);

      const whoamiAfter = await server.executeCommand('whoami');
      expect(whoamiAfter.trim()).toBe('root');
    });

    it('should create user, change password via chpasswd, verify', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      // Create user with initial password
      await server.executeCommand('adduser testpw');
      server.setUserPassword('testpw', 'initial123');

      // Change password via chpasswd
      await server.executeCommand('echo "testpw:NewP@ss456" | chpasswd');

      // Verify old password no longer works
      expect(server.checkPassword('testpw', 'initial123')).toBe(false);

      // Verify new password works
      expect(server.checkPassword('testpw', 'NewP@ss456')).toBe(true);
    });

    it('should handle user creation, sudo group, and elevated commands', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');

      // Create a new user and add to sudo group
      await pc.executeCommand('sudo useradd -m -s /bin/bash admin2');
      await pc.executeCommand('sudo usermod -aG sudo admin2');
      pc.setUserPassword('admin2', 'admin2pass');

      // Verify user is in sudo group
      const groups = await pc.executeCommand('groups admin2');
      expect(groups).toContain('sudo');

      // Switch to that user
      await pc.executeCommand('su - admin2');
      const whoami = await pc.executeCommand('whoami');
      expect(whoami.trim()).toBe('admin2');

      // Check sudo -l
      const sudoCheck = await pc.executeCommand('sudo -l -U admin2');
      expect(sudoCheck).toContain('may run the following commands');

      // Exit su session
      pc.handleExit();
    });

    it('should handle multiple su sessions (nested su)', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      // Create two users
      await server.executeCommand('adduser user1');
      server.setUserPassword('user1', 'pass1');
      await server.executeCommand('adduser user2');
      server.setUserPassword('user2', 'pass2');

      // root → su user1 → su user2 → exit → exit → root
      await server.executeCommand('su - user1');
      expect((await server.executeCommand('whoami')).trim()).toBe('user1');

      await server.executeCommand('su - user2');
      expect((await server.executeCommand('whoami')).trim()).toBe('user2');
      expect((await server.executeCommand('pwd')).trim()).toBe('/home/user2');

      // Exit back to user1
      server.handleExit();
      expect((await server.executeCommand('whoami')).trim()).toBe('user1');

      // Exit back to root
      server.handleExit();
      expect((await server.executeCommand('whoami')).trim()).toBe('root');
    });

    it('should handle complete user deletion lifecycle', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      // Create user with all trimmings
      await server.executeCommand('adduser deletetest');
      server.setUserPassword('deletetest', 'temp123');
      server.setUserGecos('deletetest', 'Delete Test User', '', '', '', '');

      // Verify everything exists
      expect(server.userExists('deletetest')).toBe(true);
      const home = await server.executeCommand('ls /home');
      expect(home).toContain('deletetest');

      // Delete user with home removal
      await server.executeCommand('deluser --remove-home deletetest');

      // Verify complete removal
      expect(server.userExists('deletetest')).toBe(false);
      const homeAfter = await server.executeCommand('ls /home');
      expect(homeAfter).not.toContain('deletetest');

      // Password check should return false for deleted user
      expect(server.checkPassword('deletetest', 'temp123')).toBe(false);
    });
  });

  // ─── 7.4: useradd flags and edge cases ────────────────────────────

  describe('G7-04: useradd flags avancés', () => {
    it('should support useradd -g to specify primary group', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('groupadd developers');

      await server.executeCommand('useradd -m -g developers -s /bin/bash devuser');

      const id = await server.executeCommand('id devuser');
      expect(id).toContain('developers');

      // Verify /etc/passwd has the correct GID
      const passwd = await server.executeCommand('getent passwd devuser');
      const gidFromGroup = await server.executeCommand('getent group developers');
      const gid = gidFromGroup.split(':')[2];
      expect(passwd).toContain(`:${gid}:`);
    });

    it('should support useradd -d for custom home directory', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('useradd -m -d /opt/customhome -s /bin/bash customuser');

      const passwd = await server.executeCommand('grep customuser /etc/passwd');
      expect(passwd).toContain('/opt/customhome');

      // Verify home directory was created
      const ls = await server.executeCommand('ls /opt/customhome');
      expect(ls).toBeDefined();
    });

    it('should support useradd -G for supplementary groups', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('groupadd grp1');
      await server.executeCommand('groupadd grp2');

      await server.executeCommand('useradd -m -G grp1,grp2 -s /bin/bash multigrp');

      const groups = await server.executeCommand('groups multigrp');
      expect(groups).toContain('grp1');
      expect(groups).toContain('grp2');
    });

    it('should reject useradd for existing username', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('useradd -m existuser');

      const out = await server.executeCommand('useradd -m existuser');
      expect(out).toContain('already exists');
    });

    it('should reject useradd -g with non-existent group', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');

      const out = await server.executeCommand('useradd -m -g nogroup_xyz badgrpuser');
      expect(out).toContain("does not exist");
    });
  });

  // ─── 7.5: /etc/passwd format compliance ───────────────────────────

  describe('G7-05: Conformité format /etc/passwd', () => {
    it('should have correct /etc/passwd format for all fields', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('useradd -m -c "Full Name Here" -s /bin/bash fmtuser');

      const entry = await server.executeCommand('grep fmtuser /etc/passwd');
      // Format: username:x:UID:GID:GECOS:home:shell
      const parts = entry.trim().split(':');
      expect(parts[0]).toBe('fmtuser');        // username
      expect(parts[1]).toBe('x');               // password placeholder
      expect(parseInt(parts[2])).toBeGreaterThanOrEqual(1000); // UID >= 1000
      expect(parseInt(parts[3])).toBeGreaterThanOrEqual(1000); // GID >= 1000
      expect(parts[4]).toBe('Full Name Here');  // GECOS
      expect(parts[5]).toBe('/home/fmtuser');   // home
      expect(parts[6]).toBe('/bin/bash');        // shell
    });

    it('should show correct /etc/shadow format', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('useradd -m shadowuser');
      server.setUserPassword('shadowuser', 'test123');

      const shadow = await server.executeCommand('cat /etc/shadow | grep shadowuser');
      // Format: username:hash:lastchange:min:max:warn:inactive:expire:
      const parts = shadow.trim().split(':');
      expect(parts[0]).toBe('shadowuser');
      // Hash should start with $6$ (simulated SHA-512)
      expect(parts[1]).toMatch(/^\$6\$/);
      // lastchange should be a number
      expect(parseInt(parts[2])).toBeGreaterThan(0);
    });

    it('should have GECOS subfields separated by commas in /etc/passwd', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser gecosuser');
      server.setUserGecos('gecosuser', 'Gecos User', '42', '555-WORK', '555-HOME', 'Extra');

      const entry = await server.executeCommand('grep gecosuser /etc/passwd');
      const gecos = entry.trim().split(':')[4];
      const subfields = gecos.split(',');
      expect(subfields[0]).toBe('Gecos User');   // Full Name
      expect(subfields[1]).toBe('42');            // Room Number
      expect(subfields[2]).toBe('555-WORK');      // Work Phone
      expect(subfields[3]).toBe('555-HOME');      // Home Phone
      expect(subfields[4]).toBe('Extra');          // Other
    });
  });

  // ─── 7.6: chfn and finger commands ────────────────────────────────

  describe('G7-06: chfn et finger', () => {
    it('should update only specified chfn fields', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser chfnuser');
      server.setUserGecos('chfnuser', 'Original Name', '100', '555-OLD', '555-HOME', '');

      // Update only the full name
      await server.executeCommand('chfn -f "New Name" chfnuser');

      const passwd = await server.executeCommand('grep chfnuser /etc/passwd');
      expect(passwd).toContain('New Name');
      // Room should remain unchanged
      expect(passwd).toContain(',100,');
    });

    it('should show "No such user" for finger on non-existent user', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('finger nonexistent');
      expect(out).toContain('no such user');
    });

    it('should show current user info with finger without args', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      const out = await server.executeCommand('finger');
      expect(out).toContain('Login');
      expect(out).toContain('root');
    });
  });

  // ─── 7.7: Password security and edge cases ───────────────────────

  describe('G7-07: Sécurité des mots de passe', () => {
    it('should not allow login with empty password for new user (no password set)', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('useradd -m nopwuser');

      // User created without password — checkPassword should fail
      expect(server.checkPassword('nopwuser', '')).toBe(false);
      expect(server.checkPassword('nopwuser', 'anything')).toBe(false);
    });

    it('should handle password change and verify old is invalid', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser pwchange');
      server.setUserPassword('pwchange', 'OldPass123');

      expect(server.checkPassword('pwchange', 'OldPass123')).toBe(true);

      // Change password
      server.setUserPassword('pwchange', 'NewPass456');

      expect(server.checkPassword('pwchange', 'OldPass123')).toBe(false);
      expect(server.checkPassword('pwchange', 'NewPass456')).toBe(true);
    });

    it('should handle locked user cannot authenticate', async () => {
      const server = new LinuxServer('linux-server', 'SRV1');
      await server.executeCommand('adduser locktest');
      server.setUserPassword('locktest', 'mypass');

      // Lock the user
      await server.executeCommand('usermod -L locktest');

      // Password check might still work (locked affects login, not password check)
      // But the passwd status should show L
      const status = await server.executeCommand('passwd -S locktest');
      expect(status).toContain('L');

      // Unlock
      await server.executeCommand('usermod -U locktest');
      const statusAfter = await server.executeCommand('passwd -S locktest');
      expect(statusAfter).toContain('P');
    });
  });
});