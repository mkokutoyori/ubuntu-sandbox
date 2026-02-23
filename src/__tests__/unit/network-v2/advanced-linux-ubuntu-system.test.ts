/**
 * TDD Tests for Advanced Linux Ubuntu Systems (DET-L4-001)
 * 
 * Group 1: Advanced Filesystem Management
 * Group 2: User & Group Management with Advanced Features
 * Group 3: Permission & Access Control Models
 * Group 4: Disk Management & Advanced Mount Options
 * Group 5: Security Hardening & Compliance
 * Group 6: Backup, Snapshot & Disaster Recovery
 * Group 7: Container & Virtualization Integration
 * Group 8: Performance Monitoring & Tuning
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  resetCounters,
} from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Filesystem } from '@/network/core/filesystem/Filesystem';
import { UserManager } from '@/network/core/auth/UserManager';
import { AuditManager } from '@/network/core/security/AuditManager';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Advanced Filesystem Management
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Advanced Filesystem Management', () => {

  // F-UBU-01: Advanced Filesystem Operations
  describe('F-UBU-01: Advanced Filesystem Operations', () => {
    it('should create and manage Btrfs filesystem with subvolumes and snapshots', async () => {
      const server = new LinuxServer('linux-server', 'BTRFS-SRV');
      
      // Create Btrfs filesystem
      const createOutput = await server.executeCommand('sudo mkfs.btrfs -f -L DATA /dev/sdb1');
      expect(createOutput).toContain('filesystem created') || expect(createOutput).toBe('');
      
      // Mount filesystem
      await server.executeCommand('sudo mkdir -p /mnt/data');
      await server.executeCommand('sudo mount -t btrfs /dev/sdb1 /mnt/data');
      
      // Create subvolumes
      await server.executeCommand('sudo btrfs subvolume create /mnt/data/home');
      await server.executeCommand('sudo btrfs subvolume create /mnt/data/var');
      await server.executeCommand('sudo btrfs subvolume create /mnt/data/srv');
      
      // Create read-only snapshot
      await server.executeCommand('sudo btrfs subvolume snapshot -r /mnt/data/home /mnt/data/home-snapshot-$(date +%Y%m%d)');
      
      // List subvolumes
      const subvolumes = await server.executeCommand('sudo btrfs subvolume list /mnt/data');
      expect(subvolumes).toContain('ID');
      expect(subvolumes).toContain('home');
      expect(subvolumes).toContain('var');
      
      // Show filesystem usage
      const usage = await server.executeCommand('sudo btrfs filesystem usage /mnt/data');
      expect(usage).toContain('Device size');
      expect(usage).toContain('Used');
      expect(usage).toContain('Free');
      
      // Enable compression
      await server.executeCommand('sudo btrfs property set /mnt/data compression zstd');
      
      // Defragment filesystem
      await server.executeCommand('sudo btrfs filesystem defragment -r /mnt/data');
      
      // Balance filesystem
      const balanceOutput = await server.executeCommand('sudo btrfs balance start -dusage=80 /mnt/data');
      expect(balanceOutput).toContain('balance') || expect(balanceOutput).toBe('');
      
      // Show space info
      const spaceInfo = await server.executeCommand('sudo btrfs filesystem df /mnt/data');
      expect(spaceInfo).toContain('Data');
      expect(spaceInfo).toContain('Metadata');
      expect(spaceInfo).toContain('System');
      
      // Unmount and mount with specific options
      await server.executeCommand('sudo umount /mnt/data');
      await server.executeCommand('sudo mount -t btrfs -o compress=zstd,noatime,space_cache=v2 /dev/sdb1 /mnt/data');
      
      // Verify mount options
      const mountInfo = await server.executeCommand('mount | grep /mnt/data');
      expect(mountInfo).toContain('compress=zstd');
      expect(mountInfo).toContain('noatime');
      
      // Cleanup
      await server.executeCommand('sudo umount /mnt/data');
    });

    it('should implement ZFS storage pool with datasets and snapshots', async () => {
      const server = new LinuxServer('linux-server', 'ZFS-SRV');
      
      // Install ZFS (simulated)
      await server.executeCommand('sudo apt-get install -y zfsutils-linux');
      
      // Create ZFS pool
      const poolCreate = await server.executeCommand('sudo zpool create -f tank mirror /dev/sdb /dev/sdc');
      expect(poolCreate).toBe('');
      
      // Create datasets with different properties
      await server.executeCommand('sudo zfs create tank/home');
      await server.executeCommand('sudo zfs create tank/var');
      await server.executeCommand('sudo zfs create tank/docker');
      
      // Set dataset properties
      await server.executeCommand('sudo zfs set compression=lz4 tank/home');
      await server.executeCommand('sudo zfs set atime=off tank/home');
      await server.executeCommand('sudo zfs set recordsize=1M tank/docker');
      await server.executeCommand('sudo zfs set quota=100G tank/var');
      await server.executeCommand('sudo zfs set reservation=20G tank/home');
      
      // Create snapshots
      await server.executeCommand('sudo zfs snapshot tank/home@initial');
      await server.executeCommand('sudo zfs snapshot tank/home@$(date +%Y%m%d)');
      await server.executeCommand('sudo zfs snapshot tank/var@daily');
      
      // List snapshots
      const snapshots = await server.executeCommand('sudo zfs list -t snapshot -o name,creation,used,referenced');
      expect(snapshots).toContain('tank/home@initial');
      
      // Clone snapshot
      await server.executeCommand('sudo zfs clone tank/home@initial tank/home-restore');
      
      // Create recursive snapshot
      await server.executeCommand('sudo zfs snapshot -r tank@recursive_snapshot');
      
      // Rollback to snapshot
      await server.executeCommand('sudo zfs rollback tank/home@initial');
      
      // Send and receive snapshot (simulated)
      await server.executeCommand('sudo zfs send tank/home@initial | ssh backup-srv "sudo zfs recv backup/home"');
      
      // Show pool status
      const poolStatus = await server.executeCommand('sudo zpool status');
      expect(poolStatus).toContain('tank');
      expect(poolStatus).toContain('ONLINE');
      
      // Show dataset properties
      const datasetProps = await server.executeCommand('sudo zfs get all tank/home');
      expect(datasetProps).toContain('compression');
      expect(datasetProps).toContain('atime');
      expect(datasetProps).toContain('quota');
      
      // Check pool health
      const poolHealth = await server.executeCommand('sudo zpool health tank');
      expect(poolHealth).toContain('healthy') || expect(poolHealth).toBe('');
      
      // Scrub pool
      await server.executeCommand('sudo zpool scrub tank');
      
      // Export and import pool
      await server.executeCommand('sudo zpool export tank');
      const importOutput = await server.executeCommand('sudo zpool import tank');
      expect(importOutput).toContain('imported') || expect(importOutput).toBe('');
      
      // Destroy pool
      await server.executeCommand('sudo zpool destroy tank');
    });

    it('should configure LVM with thin provisioning and snapshots', async () => {
      const server = new LinuxServer('linux-server', 'LVM-SRV');
      
      // Create physical volumes
      await server.executeCommand('sudo pvcreate /dev/sdb /dev/sdc /dev/sdd');
      const pvs = await server.executeCommand('sudo pvs');
      expect(pvs).toContain('/dev/sdb');
      expect(pvs).toContain('pv');
      
      // Create volume group
      await server.executeCommand('sudo vgcreate vg_data /dev/sdb /dev/sdc');
      const vgs = await server.executeCommand('sudo vgs');
      expect(vgs).toContain('vg_data');
      
      // Create thin pool
      await server.executeCommand('sudo lvcreate -L 100G --thinpool thin_pool vg_data');
      
      // Create thin volumes
      await server.executeCommand('sudo lvcreate -V 50G --thin -n lv_home vg_data/thin_pool');
      await server.executeCommand('sudo lvcreate -V 30G --thin -n lv_var vg_data/thin_pool');
      await server.executeCommand('sudo lvcreate -V 20G --thin -n lv_docker vg_data/thin_pool');
      
      // Create filesystem on thin volumes
      await server.executeCommand('sudo mkfs.ext4 /dev/vg_data/lv_home');
      await server.executeCommand('sudo mkfs.xfs /dev/vg_data/lv_var');
      
      // Create LVM snapshot
      await server.executeCommand('sudo lvcreate -L 10G -s -n home_snapshot /dev/vg_data/lv_home');
      
      // Mount with specific options
      await server.executeCommand('sudo mkdir -p /home_lvm');
      await server.executeCommand('sudo mount -o noatime,nodiratime,data=writeback /dev/vg_data/lv_home /home_lvm');
      
      // Extend thin pool
      await server.executeCommand('sudo lvextend -L +50G vg_data/thin_pool');
      
      // Extend thin volume
      await server.executeCommand('sudo lvextend -L +10G /dev/vg_data/lv_home');
      
      // Resize filesystem online
      await server.executeCommand('sudo resize2fs /dev/vg_data/lv_home');
      
      // Show LVM information
      const lvs = await server.executeCommand('sudo lvs -o+lv_size,pool_lv,origin,data_percent,metadata_percent');
      expect(lvs).toContain('lv_home');
      expect(lvs).toContain('thin_pool');
      
      const vgdisplay = await server.executeCommand('sudo vgdisplay vg_data');
      expect(vgdisplay).toContain('VG Name');
      expect(vgdisplay).toContain('Free PE');
      
      // Activate/deactivate volume group
      await server.executeCommand('sudo vgchange -a n vg_data');
      await server.executeCommand('sudo vgchange -a y vg_data');
      
      // Rename logical volume
      await server.executeCommand('sudo lvrename vg_data lv_home lv_home_new');
      
      // Remove snapshot
      await server.executeCommand('sudo lvremove -f /dev/vg_data/home_snapshot');
      
      // Cleanup
      await server.executeCommand('sudo umount /home_lvm');
      await server.executeCommand('sudo vgremove -f vg_data');
      await server.executeCommand('sudo pvremove /dev/sdb /dev/sdc /dev/sdd');
    });

    it('should implement encrypted filesystems with LUKS', async () => {
      const server = new LinuxServer('linux-server', 'ENCRYPT-SRV');
      
      // Create encrypted partition
      await server.executeCommand('sudo cryptsetup luksFormat --type luks2 /dev/sdb1');
      
      // Open encrypted device
      await server.executeCommand('sudo cryptsetup open /dev/sdb1 crypt_data');
      
      // Create filesystem on mapped device
      await server.executeCommand('sudo mkfs.ext4 /dev/mapper/crypt_data');
      
      // Mount encrypted filesystem
      await server.executeCommand('sudo mkdir -p /mnt/encrypted');
      await server.executeCommand('sudo mount /dev/mapper/crypt_data /mnt/encrypted');
      
      // Add keyfile
      await server.executeCommand('sudo dd if=/dev/urandom of=/root/keyfile bs=1024 count=4');
      await server.executeCommand('sudo chmod 0400 /root/keyfile');
      await server.executeCommand('sudo cryptsetup luksAddKey /dev/sdb1 /root/keyfile');
      
      // Setup auto-mount via crypttab
      await server.executeCommand('echo "crypt_data /dev/sdb1 /root/keyfile luks" | sudo tee -a /etc/crypttab');
      await server.executeCommand('echo "/dev/mapper/crypt_data /mnt/encrypted ext4 defaults 0 2" | sudo tee -a /etc/fstab');
      
      // Test mount
      await server.executeCommand('sudo mount -a');
      
      // Show LUKS header info
      const luksInfo = await server.executeCommand('sudo cryptsetup luksDump /dev/sdb1');
      expect(luksInfo).toContain('LUKS header');
      expect(luksInfo).toContain('Keyslots');
      
      // Change passphrase
      await server.executeCommand('sudo cryptsetup luksChangeKey /dev/sdb1');
      
      // Backup LUKS header
      await server.executeCommand('sudo cryptsetup luksHeaderBackup /dev/sdb1 --header-backup-file /root/luks-header-backup.img');
      
      // Test restore (simulated)
      await server.executeCommand('sudo cryptsetup luksHeaderRestore /dev/sdb1 --header-backup-file /root/luks-header-backup.img');
      
      // Benchmark encryption
      const benchmark = await server.executeCommand('sudo cryptsetup benchmark');
      expect(benchmark).toContain('aes-xts');
      expect(benchmark).toContain('sha256');
      
      // Create encrypted swap
      await server.executeCommand('sudo cryptsetup -d /dev/urandom create crypt-swap /dev/sdc1');
      await server.executeCommand('sudo mkswap /dev/mapper/crypt-swap');
      await server.executeCommand('sudo swapon /dev/mapper/crypt-swap');
      
      // Show crypt device status
      const cryptStatus = await server.executeCommand('sudo cryptsetup status crypt_data');
      expect(cryptStatus).toContain('/dev/mapper/crypt_data');
      expect(cryptStatus).toContain('type');
      
      // Cleanup
      await server.executeCommand('sudo swapoff /dev/mapper/crypt-swap');
      await server.executeCommand('sudo cryptsetup close crypt-swap');
      await server.executeCommand('sudo umount /mnt/encrypted');
      await server.executeCommand('sudo cryptsetup close crypt_data');
    });
  });

  // F-UBU-02: Advanced Mount Options and Automount
  describe('F-UBU-02: Advanced Mount Options', () => {
    it('should configure complex fstab entries with advanced options', async () => {
      const server = new LinuxServer('linux-server', 'MOUNT-SRV');
      
      // Backup fstab
      await server.executeCommand('sudo cp /etc/fstab /etc/fstab.backup');
      
      // Add complex mount entries
      const fstabEntries = `
# SSD optimized mount
UUID=abcd1234-5678 /ssd ext4 noatime,nodiratime,discard,errors=remount-ro 0 2

# NFS with specific options
nfs-server:/export/data /mnt/nfs nfs rw,sync,hard,intr,rsize=65536,wsize=65536,timeo=600,retrans=2 0 0

# CIFS/SMB with credentials
//nas-server/share /mnt/smb cifs credentials=/etc/smb.credentials,uid=1000,gid=1000,file_mode=0775,dir_mode=0775,iocharset=utf8 0 0

# tmpfs for temporary files
tmpfs /tmp tmpfs defaults,noatime,mode=1777,size=2G,nr_inodes=1M 0 0

# Bind mount
/home /backup/home none bind 0 0

# Remount with specific options
/ / remount,noatime 0 0
      `;
      
      await server.executeCommand(`echo '${fstabEntries}' | sudo tee -a /etc/fstab`);
      
      // Create credentials file for SMB
      await server.executeCommand('sudo sh -c \'echo "username=nasuser\npassword=naspass" > /etc/smb.credentials\'');
      await server.executeCommand('sudo chmod 600 /etc/smb.credentials');
      
      // Test fstab without mounting
      const mountTest = await server.executeCommand('sudo mount -a --fake');
      expect(mountTest).toBe('');
      
      // Create directories
      await server.executeCommand('sudo mkdir -p /ssd /mnt/nfs /mnt/smb /backup/home');
      
      // Real mount test
      const mountOutput = await server.executeCommand('sudo mount -a');
      expect(mountOutput).toBe('');
      
      // Show mount information
      const mountInfo = await server.executeCommand('mount');
      expect(mountInfo).toContain('noatime');
      expect(mountInfo).toContain('nfs');
      expect(mountInfo).toContain('cifs');
      
      // Show specific mount options
      const ssdMount = await server.executeCommand('mount | grep /ssd');
      expect(ssdMount).toContain('discard');
      expect(ssdMount).toContain('noatime');
      
      // Test bind mount
      await server.executeCommand('sudo touch /home/testfile');
      const bindTest = await server.executeCommand('ls /backup/home/testfile');
      expect(bindTest).toContain('testfile');
      
      // Remount with different options
      await server.executeCommand('sudo mount -o remount,ro /ssd');
      const roTest = await server.executeCommand('touch /ssd/test-ro');
      expect(roTest).toContain('Read-only');
      
      // Restore read-write
      await server.executeCommand('sudo mount -o remount,rw /ssd');
      
      // Show filesystem disk space usage with human readable
      const dfOutput = await server.executeCommand('df -hT');
      expect(dfOutput).toContain('Filesystem');
      expect(dfOutput).toContain('Type');
      expect(dfOutput).toContain('Size');
      
      // Show inode usage
      const inodeOutput = await server.executeCommand('df -i');
      expect(inodeOutput).toContain('Inodes');
      expect(inodeOutput).toContain('IUsed');
      
      // Cleanup
      await server.executeCommand('sudo umount -a');
      await server.executeCommand('sudo cp /etc/fstab.backup /etc/fstab');
    });

    it('should implement autofs for automatic mounting', async () => {
      const server = new LinuxServer('linux-server', 'AUTOFS-SRV');
      
      // Install autofs
      await server.executeCommand('sudo apt-get install -y autofs');
      
      // Configure autofs master map
      await server.executeCommand('sudo sh -c \'echo "/mnt/autofs /etc/auto.master --timeout=300" >> /etc/auto.master\'');
      
      // Create auto.misc configuration
      const autoMisc = `
nfs  -fstype=nfs,rw,sync,hard,intr  nfs-server:/export/nfs
smb  -fstype=cifs,credentials=/etc/auto.smb.credentials  ://nas-server/share
home -fstype=nfs,rw,sync  nfs-server:/export/home/&
ftp  -fstype=fuse,rw,allow_other  :curlftpfs#ftp://user:pass@ftp.server.com/
ssh  -fstype=fuse,rw,allow_other,IdentityFile=/home/user/.ssh/id_rsa  :sshfs#user@ssh.server.com:/remote/path
      `;
      
      await server.executeCommand(`echo '${autoMisc}' | sudo tee /etc/auto.misc`);
      
      // Create credentials file
      await server.executeCommand('sudo sh -c \'echo "username=nasuser\npassword=naspass" > /etc/auto.smb.credentials\'');
      await server.executeCommand('sudo chmod 600 /etc/auto.smb.credentials');
      
      // Configure auto.home for dynamic home directories
      const autoHome = `
*  -fstype=nfs,rw,sync,hard  nfs-server:/export/home/&
      `;
      
      await server.executeCommand(`echo '${autoHome}' | sudo tee /etc/auto.home`);
      
      // Restart autofs
      await server.executeCommand('sudo systemctl restart autofs');
      
      // Test autofs - accessing mount point should trigger mount
      await server.executeCommand('ls /mnt/autofs/nfs');
      
      // Check if mounted
      const autofsMounts = await server.executeCommand('mount | grep autofs');
      expect(autofsMounts).toContain('nfs-server');
      
      // Show autofs status
      const autofsStatus = await server.executeCommand('sudo systemctl status autofs');
      expect(autofsStatus).toContain('active (running)');
      
      // Test timeout - mount should disappear after timeout
      await server.executeCommand('sudo automount -f');
      
      // Configure direct maps
      await server.executeCommand('sudo sh -c \'echo "/- /etc/auto.direct --timeout=600" >> /etc/auto.master\'');
      
      const autoDirect = `
/mnt/direct/nas  -fstype=nfs,rw  nas-server:/export/data
/mnt/direct/backup  -fstype=cifs,credentials=/etc/auto.smb.credentials  ://backup-server/backup
      `;
      
      await server.executeCommand(`echo '${autoDirect}' | sudo tee /etc/auto.direct`);
      
      // Reload autofs
      await server.executeCommand('sudo systemctl reload autofs');
      
      // Test direct map
      await server.executeCommand('ls /mnt/direct/nas');
      
      // Show autofs mounts
      const showmounts = await server.executeCommand('sudo automount -m');
      expect(showmounts).toContain('Mount point');
      
      // Cleanup
      await server.executeCommand('sudo systemctl stop autofs');
      await server.executeCommand('sudo rm -f /etc/auto.master /etc/auto.misc /etc/auto.home /etc/auto.direct');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Advanced User & Group Management
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Advanced User & Group Management', () => {

  // U-UBU-01: Advanced User Management
  describe('U-UBU-01: Advanced User Management', () => {
    it('should manage users with complex attributes and password policies', async () => {
      const server = new LinuxServer('linux-server', 'USER-MGMT-SRV');
      
      // Create user with specific UID, GID, home, and shell
      await server.executeCommand('sudo useradd -m -u 2001 -g users -G sudo,adm,docker -s /bin/bash -c "Application User" -d /home/appuser -k /etc/skel-app appuser');
      
      // Set complex password
      await server.executeCommand('echo "appuser:$(openssl passwd -6 \'ComplexP@ssw0rd!2024\')" | sudo chpasswd -e');
      
      // Verify user creation
      const userInfo = await server.executeCommand('id appuser');
      expect(userInfo).toContain('2001');
      expect(userInfo).toContain('sudo');
      expect(userInfo).toContain('docker');
      
      const passwdEntry = await server.executeCommand('sudo getent passwd appuser');
      expect(passwdEntry).toContain('/home/appuser');
      expect(passwdEntry).toContain('/bin/bash');
      
      // Set password expiration
      await server.executeCommand('sudo chage -M 90 -m 7 -W 14 -I 30 -E $(date -d "+365 days" +%Y-%m-%d) appuser');
      
      // Show password aging info
      const chageInfo = await server.executeCommand('sudo chage -l appuser');
      expect(chageInfo).toContain('Maximum number of days');
      expect(chageInfo).toContain('Minimum number of days');
      expect(chageInfo).toContain('Warning');
      
      // Lock and unlock account
      await server.executeCommand('sudo usermod -L appuser');
      const lockedStatus = await server.executeCommand('sudo passwd -S appuser');
      expect(lockedStatus).toContain('L');
      
      await server.executeCommand('sudo usermod -U appuser');
      const unlockedStatus = await server.executeCommand('sudo passwd -S appuser');
      expect(unlockedStatus).toContain('P');
      
      // Set account expiration
      await server.executeCommand('sudo usermod -e $(date -d "+30 days" +%Y-%m-%d) appuser');
      
      // Modify user properties
      await server.executeCommand('sudo usermod -c "Modified Application User" -s /bin/zsh -d /opt/appuser -m appuser');
      
      // Add user to additional groups
      await server.executeCommand('sudo usermod -aG www-data,postgres,redis appuser');
      
      // Set login class (FreeBSD style, simulated for Linux)
      await server.executeCommand('sudo usermod -K loginclass=staff appuser');
      
      // Create system user without home
      await server.executeCommand('sudo useradd -r -s /usr/sbin/nologin -c "System Service User" systemuser');
      
      // Create user with specific login.defs defaults
      await server.executeCommand('sudo useradd -D -b /home -g users -s /bin/bash -f 30 -e ""');
      
      // Show default useradd configuration
      const defaults = await server.executeCommand('sudo useradd -D');
      expect(defaults).toContain('HOME=/home');
      expect(defaults).toContain('SHELL=/bin/bash');
      
      // Create user with skeleton directory
      await server.executeCommand('sudo mkdir -p /etc/skel-app/.ssh');
      await server.executeCommand('sudo cp /home/user/.ssh/authorized_keys /etc/skel-app/.ssh/');
      await server.executeCommand('sudo useradd -m -k /etc/skel-app skeluser');
      
      // Verify skeleton files
      const skelCheck = await server.executeCommand('ls -la /home/skeluser/.ssh/');
      expect(skelCheck).toContain('authorized_keys');
      
      // Delete user with home removal
      await server.executeCommand('sudo userdel -r skeluser');
      
      // Create user with encrypted home directory (eCryptfs)
      await server.executeCommand('sudo adduser --encrypt-home secureuser');
      
      // Show all users
      const allUsers = await server.executeCommand('getent passwd | cut -d: -f1 | sort');
      expect(allUsers).toContain('appuser');
      expect(allUsers).toContain('systemuser');
      
      // Cleanup
      await server.executeCommand('sudo userdel -r appuser');
      await server.executeCommand('sudo userdel -r systemuser');
      await server.executeCommand('sudo userdel -r secureuser');
    });

    it('should implement centralized authentication with LDAP/SSSD', async () => {
      const server = new LinuxServer('linux-server', 'AUTH-SRV');
      
      // Install LDAP/SSSD packages
      await server.executeCommand('sudo apt-get install -y sssd sssd-tools libpam-sss libnss-sss ldap-utils');
      
      // Configure SSSD
      const sssdConf = `
[sssd]
config_file_version = 2
services = nss, pam
domains = example.com

[domain/example.com]
id_provider = ldap
auth_provider = ldap
ldap_uri = ldap://ldap.example.com
ldap_search_base = dc=example,dc=com
ldap_tls_reqcert = demand
ldap_tls_cacert = /etc/ssl/certs/ca-certificates.crt
enumerate = false
cache_credentials = true
ldap_default_bind_dn = cn=admin,dc=example,dc=com
ldap_default_authtok = password
      `;
      
      await server.executeCommand(`echo '${sssdConf}' | sudo tee /etc/sssd/sssd.conf`);
      await server.executeCommand('sudo chmod 600 /etc/sssd/sssd.conf');
      
      // Configure PAM
      await server.executeCommand('sudo pam-auth-update --enable sssd');
      
      // Configure NSS
      await server.executeCommand('sudo sed -i "s/passwd:.*/passwd:         compat sss/" /etc/nsswitch.conf');
      await server.executeCommand('sudo sed -i "s/group:.*/group:          compat sss/" /etc/nsswitch.conf');
      await server.executeCommand('sudo sed -i "s/shadow:.*/shadow:         compat sss/" /etc/nsswitch.conf');
      await server.executeCommand('sudo sed -i "s/sudoers:.*/sudoers:        files sss/" /etc/nsswitch.conf');
      
      // Restart SSSD
      await server.executeCommand('sudo systemctl restart sssd');
      
      // Test LDAP search
      const ldapSearch = await server.executeCommand('ldapsearch -x -H ldap://ldap.example.com -b dc=example,dc=com "(uid=testuser)"');
      expect(ldapSearch).toContain('search result');
      
      // Test SSSD cache
      await server.executeCommand('sudo getent passwd ldapuser');
      await server.executeCommand('sudo getent group ldapgroup');
      
      // Show SSSD status
      const sssdStatus = await server.executeCommand('sudo systemctl status sssd');
      expect(sssdStatus).toContain('active (running)');
      
      // Clear SSSD cache
      await server.executeCommand('sudo sss_cache -E');
      
      // Show cached users
      const cachedUsers = await server.executeCommand('sudo sss_cache -U');
      
      // Configure automatic home creation
      const pamConfig = `
session required pam_mkhomedir.so skel=/etc/skel/ umask=0022
      `;
      
      await server.executeCommand(`echo '${pamConfig}' | sudo tee -a /etc/pam.d/common-session`);
      
      // Test authentication
      const authTest = await server.executeCommand('sudo sss_ssh_authorizedkeys ldapuser');
      expect(authTest).toContain('ssh-rsa') || expect(authTest).toBe('');
      
      // Configure sudo with LDAP
      const sudoLdap = `
sudoers: ldap ldap://ldap.example.com/ou=sudoers,dc=example,dc=com
      `;
      
      await server.executeCommand(`echo '${sudoLdap}' | sudo tee -a /etc/ldap.conf`);
      
      // Test sudo lookup
      const sudoTest = await server.executeCommand('sudo -l -U ldapuser');
      
      // Configure offline authentication
      await server.executeCommand('sudo sss_override user-add ldapuser --cache-expiration=99999');
      
      // Show SSSD debug logs
      const sssdDebug = await server.executeCommand('sudo sssctl domain-status example.com');
      expect(sssdDebug).toContain('Online status');
      
      // Cleanup
      await server.executeCommand('sudo systemctl stop sssd');
      await server.executeCommand('sudo rm -f /etc/sssd/sssd.conf');
    });

    it('should implement Pluggable Authentication Modules (PAM) with complex policies', async () => {
      const server = new LinuxServer('linux-server', 'PAM-SRV');
      
      // Backup PAM configuration
      await server.executeCommand('sudo cp -r /etc/pam.d /etc/pam.d.backup');
      
      // Configure password policy
      const commonPassword = `
password requisite pam_pwquality.so retry=3 minlen=12 dcredit=-1 ucredit=-1 ocredit=-1 lcredit=-1
password requisite pam_unix.so sha512 shadow nullok try_first_pass use_authtok
password required pam_deny.so
      `;
      
      await server.executeCommand(`echo '${commonPassword}' | sudo tee /etc/pam.d/common-password`);
      
      // Configure account policy
      const commonAccount = `
account requisite pam_time.so
account required pam_unix.so
account sufficient pam_localuser.so
account sufficient pam_succeed_if.so uid < 1000 quiet
account required pam_permit.so
      `;
      
      await server.executeCommand(`echo '${commonAccount}' | sudo tee /etc/pam.d/common-account`);
      
      // Configure session policy
      const commonSession = `
session required pam_limits.so
session required pam_unix.so
session optional pam_systemd.so
session optional pam_mkhomedir.so skel=/etc/skel/ umask=0022
session required pam_env.so readenv=1
session required pam_env.so readenv=1 envfile=/etc/default/locale
      `;
      
      await server.executeCommand(`echo '${commonSession}' | sudo tee /etc/pam.d/common-session`);
      
      // Configure authentication policy with 2FA
      const commonAuth = `
auth required pam_google_authenticator.so nullok
auth required pam_unix.so nullok_secure try_first_pass
auth requisite pam_deny.so
auth required pam_permit.so
      `;
      
      await server.executeCommand(`echo '${commonAuth}' | sudo tee /etc/pam.d/common-auth`);
      
      // Configure sudo PAM policy
      const sudoPam = `
auth sufficient pam_google_authenticator.so nullok
auth required pam_unix.so use_first_pass
auth required pam_deny.so
auth required pam_permit.so
      `;
      
      await server.executeCommand(`echo '${sudoPam}' | sudo tee /etc/pam.d/sudo`);
      
      // Configure SSH PAM policy
      const sshdPam = `
auth requisite pam_google_authenticator.so nullok
auth required pam_unix.so use_first_pass
auth required pam_deny.so
auth required pam_permit.so
      `;
      
      await server.executeCommand(`echo '${sshdPam}' | sudo tee /etc/pam.d/sshd`);
      
      // Configure time-based restrictions
      const timeConf = `
*;*;*;Al0000-2400
login;*;*;!Al0000-0600
sshd;*;*;!Wk1800-0800
      `;
      
      await server.executeCommand(`echo '${timeConf}' | sudo tee /etc/security/time.conf`);
      
      // Configure access limits
      const limitsConf = `
* soft nproc 100
* hard nproc 500
* soft nofile 4096
* hard nofile 8192
@admins hard nproc unlimited
@users soft nproc 200
      `;
      
      await server.executeCommand(`echo '${limitsConf}' | sudo tee /etc/security/limits.conf`);
      
      // Configure login defenses
      await server.executeCommand('sudo apt-get install -y fail2ban');
      
      const jailLocal = `
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
findtime = 600
      `;
      
      await server.executeCommand(`echo '${jailLocal}' | sudo tee /etc/fail2ban/jail.local`);
      
      // Restart fail2ban
      await server.executeCommand('sudo systemctl restart fail2ban');
      
      // Test PAM configuration
      const pamTest = await server.executeCommand('sudo pam_tally2 --user testuser');
      expect(pamTest).toContain('Login');
      
      // Reset failed attempts
      await server.executeCommand('sudo pam_tally2 --user testuser --reset');
      
      // Test password quality
      const pwqualityTest = await server.executeCommand('echo "weakpass" | sudo pwscore');
      expect(parseInt(pwqualityTest)).toBeLessThan(50);
      
      // Show current limits
      const ulimitOutput = await server.executeCommand('ulimit -a');
      expect(ulimitOutput).toContain('open files');
      expect(ulimitOutput).toContain('max user processes');
      
      // Test fail2ban status
      const fail2banStatus = await server.executeCommand('sudo fail2ban-client status sshd');
      expect(fail2banStatus).toContain('Status');
      
      // Configure Google Authenticator for a user
      await server.executeCommand('sudo -u testuser google-authenticator -t -d -f -r 3 -R 30 -w 3');
      
      // Cleanup
      await server.executeCommand('sudo rm -rf /etc/pam.d');
      await server.executeCommand('sudo mv /etc/pam.d.backup /etc/pam.d');
      await server.executeCommand('sudo systemctl stop fail2ban');
    });
  });

  // U-UBU-02: Advanced Group Management
  describe('U-UBU-02: Advanced Group Management', () => {
    it('should manage groups with complex permissions and membership', async () => {
      const server = new LinuxServer('linux-server', 'GROUP-MGMT-SRV');
      
      // Create primary groups
      await server.executeCommand('sudo groupadd -g 3001 developers');
      await server.executeCommand('sudo groupadd -g 3002 operators');
      await server.executeCommand('sudo groupadd -g 3003 auditors');
      await server.executeCommand('sudo groupadd -g 3004 administrators');
      
      // Create system groups
      await server.executeCommand('sudo groupadd -r systemd');
      await server.executeCommand('sudo groupadd -r docker');
      await server.executeCommand('sudo groupadd -r kvm');
      
      // Create groups with specific password (shadow group)
      await server.executeCommand('sudo groupadd -p $(openssl passwd -6 "group_password") securegroup');
      
      // Create user with primary group
      await server.executeCommand('sudo useradd -m -g developers -G sudo,docker devuser');
      
      // Add users to multiple groups
      await server.executeCommand('sudo usermod -aG operators,auditors devuser');
      await server.executeCommand('sudo usermod -aG administrators,systemd,kvm sysadmin');
      
      // Verify group membership
      const groupsOutput = await server.executeCommand('groups devuser');
      expect(groupsOutput).toContain('developers');
      expect(groupsOutput).toContain('operators');
      expect(groupsOutput).toContain('auditors');
      expect(groupsOutput).toContain('sudo');
      
      // Show group information
      const groupInfo = await server.executeCommand('getent group developers');
      expect(groupInfo).toContain('3001');
      expect(groupInfo).toContain('devuser');
      
      // List all groups
      const allGroups = await server.executeCommand('getent group | cut -d: -f1 | sort');
      expect(allGroups).toContain('developers');
      expect(allGroups).toContain('operators');
      expect(allGroups).toContain('auditors');
      
      // Create group with administrators
      await server.executeCommand('sudo groupadd --admin admin1,admin2 admins');
      
      // Set group password (for users to join via newgrp)
      await server.executeCommand('sudo gpasswd developers');
      
      // Add group administrators
      await server.executeCommand('sudo gpasswd -A devuser developers');
      
      // Allow users to join group without administrator
      await server.executeCommand('sudo gpasswd -M user1,user2,user3 developers');
      
      // Remove user from group
      await server.executeCommand('sudo gpasswd -d devuser operators');
      
      // Create nested groups (simulated with primary/secondary)
      await server.executeCommand('sudo groupadd parentgroup');
      await server.executeCommand('sudo groupadd childgroup');
      await server.executeCommand('sudo usermod -aG parentgroup,childgroup nesteduser');
      
      // Set group as primary for files
      await server.executeCommand('sudo chown :developers /home/devuser');
      
      // Create files with specific group ownership
      await server.executeCommand('sudo install -o root -g developers -m 2775 -d /opt/devproject');
      
      // Set SGID on directory (files inherit group)
      await server.executeCommand('sudo chmod g+s /opt/devproject');
      
      // Verify SGID
      const sgidCheck = await server.executeCommand('ls -ld /opt/devproject');
      expect(sgidCheck).toContain('2775');
      expect(sgidCheck).toContain('developers');
      
      // Create files to test inheritance
      await server.executeCommand('sudo touch /opt/devproject/testfile');
      const fileGroup = await server.executeCommand('ls -l /opt/devproject/testfile');
      expect(fileGroup).toContain('developers');
      
      // Delete group with force
      await server.executeCommand('sudo groupdel -f testgroup');
      
      // Clean group without members
      await server.executeCommand('sudo groupdel emptygroup');
      
      // Show group members
      const groupMembers = await server.executeCommand('getent group developers | cut -d: -f4');
      expect(groupMembers).toContain('devuser');
      
      // Change group GID
      await server.executeCommand('sudo groupmod -g 4001 developers');
      
      // Change group name
      await server.executeCommand('sudo groupmod -n devteam developers');
      
      // Verify changes
      const renamedGroup = await server.executeCommand('getent group devteam');
      expect(renamedGroup).toContain('4001');
      
      // Create encrypted group (simulated)
      await server.executeCommand('sudo groupadd --encrypted securegroup');
      
      // Set group quota (if supported)
      await server.executeCommand('sudo setquota -g developers 1000000 1200000 0 0 /home');
      
      // Show group quota
      const groupQuota = await server.executeCommand('sudo quota -g developers');
      expect(groupQuota).toContain('developers') || expect(groupQuota).toBe('');
      
      // Cleanup
      await server.executeCommand('sudo userdel -r devuser');
      await server.executeCommand('sudo userdel -r sysadmin');
      await server.executeCommand('sudo userdel -r nesteduser');
      await server.executeCommand('sudo groupdel devteam');
      await server.executeCommand('sudo groupdel operators');
      await server.executeCommand('sudo groupdel auditors');
      await server.executeCommand('sudo groupdel administrators');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: Advanced Permission & Access Control
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Advanced Permission & Access Control', () => {

  // P-UBU-01: Advanced POSIX Permissions
  describe('P-UBU-01: Advanced POSIX Permissions', () => {
    it('should implement complex permission models with special bits', async () => {
      const server = new LinuxServer('linux-server', 'PERM-SRV');
      
      // Create test directory structure
      await server.executeCommand('sudo mkdir -p /test/{dir1,dir2,dir3}/{sub1,sub2}');
      await server.executeCommand('sudo touch /test/{file1,file2,file3}.txt');
      
      // Set SUID (Set User ID) - program runs with owner's privileges
      await server.executeCommand('sudo chmod u+s /usr/bin/passwd');
      const suidCheck = await server.executeCommand('ls -l /usr/bin/passwd');
      expect(suidCheck).toContain('rws');
      
      // Set SGID (Set Group ID) - files inherit directory's group
      await server.executeCommand('sudo chmod g+s /test/dir1');
      const sgidCheck = await server.executeCommand('ls -ld /test/dir1');
      expect(sgidCheck).toContain('rws');
      
      // Set sticky bit - only owner can delete files in directory
      await server.executeCommand('sudo chmod +t /tmp');
      const stickyCheck = await server.executeCommand('ls -ld /tmp');
      expect(stickyCheck).toContain('rwt');
      
      // Set octal permissions with special bits
      await server.executeCommand('sudo chmod 4755 /test/file1.txt');  // SUID
      await server.executeCommand('sudo chmod 2755 /test/dir2');       // SGID
      await server.executeCommand('sudo chmod 1755 /test/dir3');       // Sticky
      await server.executeCommand('sudo chmod 6755 /test/file2.txt');  // SUID+SGID
      
      // Verify permissions
      const permCheck = await server.executeCommand('ls -l /test/');
      expect(permCheck).toContain('4755');
      expect(permCheck).toContain('2755');
      expect(permCheck).toContain('1755');
      
      // Set permissions using symbolic notation
      await server.executeCommand('sudo chmod u=rwx,g=rx,o= /test/secure');
      await server.executeCommand('sudo chmod a+x /test/executable');
      await server.executeCommand('sudo chmod o-w /test/nowrite');
      await server.executeCommand('sudo chmod g+s,o+t /test/special');
      
      // Copy permissions from one file to another
      await server.executeCommand('sudo chmod --reference=/test/file1.txt /test/file3.txt');
      
      // Recursive permission changes
      await server.executeCommand('sudo chmod -R 755 /test/dir1');
      await server.executeCommand('sudo chmod -R u+w /test/dir2');
      
      // Preserve root ownership while copying
      await server.executeCommand('sudo cp -a /test/file1.txt /test/file1-copy.txt');
      
      // Change ownership recursively
      await server.executeCommand('sudo chown -R root:root /test/dir1');
      
      // Change only user or only group
      await server.executeCommand('sudo chown :developers /test/dir2');
      await server.executeCommand('sudo chown www-data: /test/dir3');
      
      // Preserve symlinks (don't follow)
      await server.executeCommand('sudo chown -h root:root /test/link');
      
      // Set default permissions with umask
      const oldUmask = await server.executeCommand('umask');
      await server.executeCommand('umask 0027');  // rwxr-x---
      
      // Create files with new umask
      await server.executeCommand('touch /test/newfile.txt');
      const newPerms = await server.executeCommand('ls -l /test/newfile.txt');
      expect(newPerms).toContain('640');  // 666 - 027 = 640
      
      // Restore umask
      await server.executeCommand(`umask ${oldUmask}`);
      
      // Set ACL mask (modifies effective permissions)
      await server.executeCommand('sudo setfacl -m m::rx /test/dir1');
      
      // Check permissions with stat
      const statOutput = await server.executeCommand('stat -c "%a %A %U:%G" /test/file1.txt');
      expect(statOutput).toContain('4755');
      
      // Find files with specific permissions
      const suidFiles = await server.executeCommand('sudo find /usr/bin -type f -perm /4000');
      expect(suidFiles).toContain('/usr/bin/passwd');
      
      const worldWritable = await server.executeCommand('sudo find /test -type f -perm /o+w');
      
      // Remove dangerous permissions
      await server.executeCommand('sudo find /test -type f -perm /o+w -exec chmod o-w {} \\;');
      await server.executeCommand('sudo find /test -type f -perm /4000 -exec chmod u-s {} \\;');
      
      // Set immutable attribute (if supported)
      await server.executeCommand('sudo chattr +i /test/immutable.txt');
      const immutableTest = await server.executeCommand('sudo rm /test/immutable.txt');
      expect(immutableTest).toContain('Operation not permitted');
      
      // Remove immutable attribute
      await server.executeCommand('sudo chattr -i /test/immutable.txt');
      
      // Set append-only attribute
      await server.executeCommand('sudo chattr +a /test/appendonly.log');
      
      // Cleanup
      await server.executeCommand('sudo rm -rf /test');
      await server.executeCommand('sudo chmod u-s /usr/bin/passwd');
      await server.executeCommand('sudo chmod -t /tmp');
    });

    it('should implement Access Control Lists (ACLs) with complex rules', async () => {
      const server = new LinuxServer('linux-server', 'ACL-SRV');
      
      // Install ACL utilities
      await server.executeCommand('sudo apt-get install -y acl');
      
      // Create test structure
      await server.executeCommand('sudo mkdir -p /acl-test/{dir1,dir2}')
      await server.executeCommand('sudo touch /acl-test/{file1,file2,file3}.txt')
      
      // Set ACL for specific user
      await server.executeCommand('sudo setfacl -m u:alice:rwx /acl-test/file1.txt')
      
      // Set ACL for specific group
      await server.executeCommand('sudo setfacl -m g:developers:rx /acl-test/dir1')
      
      // Set default ACL (inherited by new files)
      await server.executeCommand('sudo setfacl -m d:u:bob:rw /acl-test/dir1')
      await server.executeCommand('sudo setfacl -m d:g:auditors:r /acl-test/dir1')
      
      // Set multiple entries at once
      await server.executeCommand('sudo setfacl -m u:charlie:rwx,g:admins:r-x,o:--- /acl-test/file2.txt')
      
      // Set mask (maximum effective permissions)
      await server.executeCommand('sudo setfacl -m m::rx /acl-test/file3.txt')
      
      // Remove specific ACL entry
      await server.executeCommand('sudo setfacl -x u:alice /acl-test/file1.txt')
      
      // Remove all ACL entries
      await server.executeCommand('sudo setfacl -b /acl-test/file2.txt')
      
      // Recursive ACL application
      await server.executeCommand('sudo setfacl -R -m u:dave:r-x /acl-test/dir2')
      
      // Recursive default ACL
      await server.executeCommand('sudo setfacl -R -m d:u:eve:rw /acl-test/dir2')
      
      // Copy ACL from one file to another
      await server.executeCommand('sudo getfacl /acl-test/file1.txt | sudo setfacl --set-file=- /acl-test/file3.txt')
      
      // Show ACLs
      const aclOutput = await server.executeCommand('sudo getfacl /acl-test/file1.txt')
      expect(aclOutput).toContain('user::')
      expect(aclOutput).toContain('group::')
      expect(aclOutput).toContain('other::')
      
      // Show effective permissions
      const effectivePerms = await server.executeCommand('sudo getfacl -e /acl-test/dir1')
      expect(effectivePerms).toContain('effective:')
      
      // Test ACL inheritance
      await server.executeCommand('sudo touch /acl-test/dir1/newfile.txt')
      const inheritedACL = await server.executeCommand('sudo getfacl /acl-test/dir1/newfile.txt')
      expect(inheritedACL).toContain('user:bob:rw')
      expect(inheritedACL).toContain('group:auditors:r')
      
      // Backup and restore ACLs
      await server.executeCommand('sudo getfacl -R /acl-test > /tmp/acl-backup.txt')
      await server.executeCommand('sudo setfacl --restore=/tmp/acl-backup.txt')
      
      // Set ACL via numeric format
      await server.executeCommand('sudo setfacl -m u:1001:7 /acl-test/file1.txt')  # UID 1001 gets rwx
      
      // Set ACL for non-existent user/group (for future use)
      await server.executeCommand('sudo setfacl -m u:futureuser:rwx /acl-test/dir1')
      
      // Clean ACLs recursively
      await server.executeCommand('sudo setfacl -R -b /acl-test')
      
      // Verify no ACLs remain
      const noACL = await server.executeCommand('sudo getfacl /acl-test/file1.txt 2>&1 | grep -c "default:"')
      expect(parseInt(noACL)).toBe(0)
      
      // Cleanup
      await server.executeCommand('sudo rm -rf /acl-test /tmp/acl-backup.txt')
    });

    it('should implement SELinux/AppArmor security policies', async () => {
      const server = new LinuxServer('linux-server', 'SELINUX-SRV');
      
      // AppArmor implementation
      await server.executeCommand('sudo apt-get install -y apparmor apparmor-utils apparmor-profiles');
      
      // Check AppArmor status
      const aaStatus = await server.executeCommand('sudo aa-status');
      expect(aaStatus).toContain('apparmor module is loaded');
      expect(aaStatus).toContain('profiles are loaded');
      
      // List all profiles
      const aaProfiles = await server.executeCommand('sudo aa-status --profiled');
      expect(aaProfiles).toContain('profiles');
      
      // Create custom AppArmor profile
      const profileContent = `
#include <tunables/global>

/usr/local/bin/myapp {
  #include <abstractions/base>
  #include <abstractions/nameservice>
  
  capability net_bind_service,
  network inet tcp,
  
  /usr/local/bin/myapp r,
  /var/log/myapp.log w,
  /tmp/myapp-*.tmp rw,
  
  deny /etc/shadow r,
  deny /root/** rwx,
}
      `;
      
      await server.executeCommand(`echo '${profileContent}' | sudo tee /etc/apparmor.d/usr.local.bin.myapp`);
      
      // Load profile
      await server.executeCommand('sudo apparmor_parser -r /etc/apparmor.d/usr.local.bin.myapp');
      
      // Set profile to enforce mode
      await server.executeCommand('sudo aa-enforce /usr/local/bin/myapp');
      
      // Set profile to complain mode
      await server.executeCommand('sudo aa-complain /usr/local/bin/myapp');
      
      // Generate profile from logs
      await server.executeCommand('sudo aa-genprof /usr/local/bin/myapp');
      
      // Remove profile
      await server.executeCommand('sudo apparmor_parser -R /etc/apparmor.d/usr.local.bin.myapp');
      
      // Check if process is confined
      const aaPs = await server.executeCommand('sudo ps auxZ | grep myapp');
      expect(aaPs).toContain('myapp') || expect(aaPs).toBe('');
      
      // Analyze log for violations
      const aaLogs = await server.executeCommand('sudo dmesg | grep apparmor');
      
      // Disable AppArmor for specific binary
      await server.executeCommand('sudo aa-disable /usr/local/bin/myapp');
      
      // SELinux simulation (for Ubuntu with SELinux installed)
      await server.executeCommand('sudo apt-get install -y selinux-basics selinux-policy-default auditd');
      
      // Check SELinux status
      const sestatus = await server.executeCommand('sudo sestatus');
      expect(sestatus).toContain('SELinux status');
      
      // Get current mode
      const semode = await server.executeCommand('sudo getenforce');
      expect(semode).toContain('Enforcing') || expect(semode).toContain('Permissive') || expect(semode).toContain('Disabled');
      
      // Set SELinux to permissive
      await server.executeCommand('sudo setenforce 0');
      
      // Set SELinux to enforcing
      await server.executeCommand('sudo setenforce 1');
      
      // View SELinux context
      const context = await server.executeCommand('ls -Z /etc/passwd');
      expect(context).toContain('system_u:object_r:passwd_file_t');
      
      // Change file context
      await server.executeCommand('sudo chcon -t httpd_sys_content_t /var/www/html/index.html');
      
      // Restore default context
      await server.executeCommand('sudo restorecon -v /var/www/html/index.html');
      
      // Set default context for directory
      await server.executeCommand('sudo semanage fcontext -a -t httpd_sys_content_t "/web(/.*)?"');
      
      // Apply context recursively
      await server.executeCommand('sudo restorecon -R -v /web');
      
      // List all SELinux booleans
      const sebooleans = await server.executeCommand('sudo getsebool -a');
      expect(sebooleans).toContain('httpd_can_network_connect');
      
      // Set SELinux boolean
      await server.executeCommand('sudo setsebool -P httpd_can_network_connect on');
      
      // View audit logs
      const auditLogs = await server.executeCommand('sudo ausearch -m avc -ts today');
      
      // Generate custom policy module
      await server.executeCommand('sudo audit2allow -a -M mypolicy');
      
      // Install custom module
      await server.executeCommand('sudo semodule -i mypolicy.pp');
      
      // List loaded modules
      const modules = await server.executeCommand('sudo semodule -l');
      expect(modules).toContain('mypolicy');
      
      // Remove module
      await server.executeCommand('sudo semodule -r mypolicy');
      
      // Cleanup
      await server.executeCommand('sudo aa-disable /usr/local/bin/myapp');
      await server.executeCommand('sudo rm -f /etc/apparmor.d/usr.local.bin.myapp');
      await server.executeCommand('sudo setenforce 0');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: Advanced Disk Management
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Advanced Disk Management', () => {

  // D-UBU-01: Advanced Disk Operations
  describe('D-UBU-01: Advanced Disk Operations', () => {
    it('should implement software RAID with complex configurations', async () => {
      const server = new LinuxServer('linux-server', 'RAID-SRV');
      
      // Install mdadm
      await server.executeCommand('sudo apt-get install -y mdadm');
      
      // Create RAID 1 (Mirror)
      await server.executeCommand('sudo mdadm --create --verbose /dev/md0 --level=1 --raid-devices=2 /dev/sdb /dev/sdc');
      
      // Create filesystem on RAID
      await server.executeCommand('sudo mkfs.ext4 /dev/md0');
      
      // Mount RAID
      await server.executeCommand('sudo mkdir -p /mnt/raid1');
      await server.executeCommand('sudo mount /dev/md0 /mnt/raid1');
      
      // Create RAID 5 (Parity)
      await server.executeCommand('sudo mdadm --create --verbose /dev/md1 --level=5 --raid-devices=3 /dev/sdd /dev/sde /dev/sdf --spare-devices=1 /dev/sdg');
      
      // Create RAID 6 (Double Parity)
      await server.executeCommand('sudo mdadm --create --verbose /dev/md2 --level=6 --raid-devices=4 /dev/sdh /dev/sdi /dev/sdj /dev/sdk');
      
      // Create RAID 10 (Striped Mirror)
      await server.executeCommand('sudo mdadm --create --verbose /dev/md3 --level=10 --raid-devices=4 /dev/sdl /dev/sdm /dev/sdn /dev/sdo --layout=o2');
      
      // Show RAID status
      const mdstat = await server.executeCommand('cat /proc/mdstat');
      expect(mdstat).toContain('md0');
      expect(mdstat).toContain('md1');
      expect(mdstat).toContain('active');
      
      // Show detailed RAID info
      const detail = await server.executeCommand('sudo mdadm --detail /dev/md0');
      expect(detail).toContain('Raid Level');
      expect(detail).toContain('Array Size');
      expect(detail).toContain('State');
      
      // Save RAID configuration
      await server.executeCommand('sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf');
      await server.executeCommand('sudo update-initramfs -u');
      
      // Add spare disk
      await server.executeCommand('sudo mdadm --add /dev/md0 /dev/sdp');
      
      // Remove failed disk
      await server.executeCommand('sudo mdadm --remove /dev/md0 /dev/sdb');
      
      // Mark disk as failed
      await server.executeCommand('sudo mdadm --fail /dev/md0 /dev/sdc');
      
      // Rebuild array
      await server.executeCommand('sudo mdadm --manage /dev/md0 --re-add /dev/sdc');
      
      // Grow RAID array
      await server.executeCommand('sudo mdadm --grow /dev/md0 --raid-devices=3 --add /dev/sdq');
      
      // Change RAID level
      await server.executeCommand('sudo mdadm --grow /dev/md1 --level=6');
      
      // Check consistency
      await server.executeCommand('sudo mdadm --action=check /dev/md0');
      
      // Repair array
      await server.executeCommand('sudo mdadm --action=repair /dev/md0');
      
      // Stop RAID array
      await server.executeCommand('sudo mdadm --stop /dev/md0');
      
      // Assemble RAID array
      await server.executeCommand('sudo mdadm --assemble /dev/md0 /dev/sdb /dev/sdc');
      
      // Monitor RAID
      await server.executeCommand('sudo mdadm --monitor --daemonise --mail=admin@example.com --program=/usr/local/bin/raid-alert /dev/md0');
      
      // Zero superblock (remove RAID)
      await server.executeCommand('sudo mdadm --zero-superblock /dev/sdb /dev/sdc');
      
      // Cleanup
      await server.executeCommand('sudo umount /mnt/raid1');
      await server.executeCommand('sudo mdadm --stop /dev/md0 /dev/md1 /dev/md2 /dev/md3');
    });

    it('should implement disk encryption with TPM integration', async () => {
      const server = new LinuxServer('linux-server', 'TPM-SRV');
      
      // Install TPM tools
      await server.executeCommand('sudo apt-get install -y tpm2-tools clevis clevis-luks clevis-dracut');
      
      // Check TPM status
      const tpmStatus = await server.executeCommand('sudo systemctl status tpm2-tss');
      expect(tpmStatus).toContain('active') || expect(tpmStatus).toContain('inactive');
      
      // List TPM resources
      const tpmList = await server.executeCommand('sudo tpm2_getcap handles-persistent');
      
      // Create LUKS encrypted partition
      await server.executeCommand('sudo cryptsetup luksFormat --type luks2 /dev/sdb1');
      
      // Add TPM2 key to LUKS
      await server.executeCommand('sudo clevis luks bind -d /dev/sdb1 tpm2 \'{"pcr_ids":"7"}\'');
      
      // Test TPM decryption
      await server.executeCommand('sudo clevis luks unlock -d /dev/sdb1');
      
      // Create encrypted volume with TPM
      await server.executeCommand('sudo cryptsetup luksFormat --type luks2 --key-file <(sudo tpm2_createprimary -c primary.ctx -Q; sudo tpm2_create -C primary.ctx -G rsa2048 -u key.pub -r key.priv -Q; sudo tpm2_load -C primary.ctx -u key.pub -r key.priv -c key.ctx -Q; sudo tpm2_rsaencrypt -c key.ctx -o key.enc /dev/stdin) /dev/sdb2');
      
      // Seal secret to TPM PCRs
      await server.executeCommand('echo "MySecret" | sudo tpm2_createprimary -C o -c primary.ctx -Q');
      await server.executeCommand('sudo tpm2_create -C primary.ctx -G hmac -u hmac.pub -r hmac.priv -Q');
      await server.executeCommand('sudo tpm2_load -C primary.ctx -u hmac.pub -r hmac.priv -c hmac.ctx -Q');
      
      // Unseal secret
      await server.executeCommand('sudo tpm2_unseal -c hmac.ctx');
      
      // Measure boot components
      await server.executeCommand('sudo tpm2_pcrread sha256:0,1,2,3,4,5,6,7');
      
      // Extend PCR (simulate boot measurement)
      await server.executeCommand('echo "boot measurement" | sudo tpm2_pcrextend 7:sha256=$(echo "boot measurement" | sha256sum | cut -d" " -f1)');
      
      // Create policy based on PCR
      await server.executeCommand('sudo tpm2_createpolicy --policy-pcr -l sha256:7 -L policy.pcr');
      
      // Create object with policy
      await server.executeCommand('sudo tpm2_createprimary -C o -c primary.ctx -Q');
      await server.executeCommand('sudo tpm2_create -C primary.ctx -G rsa2048 -u key.pub -r key.priv -L policy.pcr -a "fixedtpm|fixedparent|sensitivedataorigin|userwithauth|decrypt" -Q');
      
      // Clean TPM
      await server.executeCommand('sudo tpm2_clear');
      
      // Backup TPM state
      await server.executeCommand('sudo tpm2_getcap properties-fixed > /root/tpm-state.txt');
      
      // Restore TPM (simulated)
      await server.executeCommand('sudo tpm2_startup -c');
      
      // Test TPM availability
      const tpmTest = await server.executeCommand('sudo tpm2_getrandom 8');
      expect(tpmTest).toHaveLength(16); // 8 bytes in hex
      
      // Cleanup
      await server.executeCommand('sudo cryptsetup luksClose crypt_data');
      await server.executeCommand('sudo rm -f primary.ctx key.pub key.priv key.ctx hmac.ctx policy.pcr');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: Security Hardening & Compliance
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Security Hardening & Compliance', () => {

  // S-UBU-01: System Hardening
  describe('S-UBU-01: System Hardening', () => {
    it('should implement CIS benchmark compliance hardening', async () => {
      const server = new LinuxServer('linux-server', 'HARDEN-SRV');
      
      // 1. Initial Setup
      // Remove unnecessary filesystems
      await server.executeCommand('sudo modprobe -n -v cramfs | grep -E "(cramfs|install)"');
      await server.executeCommand('sudo lsmod | grep cramfs');
      
      // Disable USB storage
      await server.executeCommand('echo "install usb-storage /bin/true" | sudo tee /etc/modprobe.d/usb-storage.conf');
      
      // 2. Services
      // Disable unnecessary services
      await server.executeCommand('sudo systemctl disable avahi-daemon');
      await server.executeCommand('sudo systemctl disable cups');
      await server.executeCommand('sudo systemctl disable isc-dhcp-server');
      
      // 3. Network Configuration
      // Configure sysctl parameters
      const sysctlConf = `
# IP Spoofing protection
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP broadcast requests
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Disable source packet routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0

# Ignore send redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# Block SYN attacks
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2

# Log Martians
net.ipv4.conf.all.log_martians = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1

# Ignore ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0

# Ignore Directed pings
net.ipv4.icmp_echo_ignore_all = 1

# Disable IPv6 if not used
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
      `;
      
      await server.executeCommand(`echo '${sysctlConf}' | sudo tee /etc/sysctl.d/99-hardening.conf`);
      await server.executeCommand('sudo sysctl -p /etc/sysctl.d/99-hardening.conf');
      
      // 4. Logging and Auditing
      // Configure auditd
      await server.executeCommand('sudo apt-get install -y auditd audispd-plugins');
      
      const auditRules = `
# Monitor system calls
-a always,exit -F arch=b64 -S adjtimex -S settimeofday -k time-change
-a always,exit -F arch=b64 -S clock_settime -k time-change
-w /etc/localtime -p wa -k time-change

# Monitor user/group changes
-w /etc/group -p wa -k identity
-w /etc/passwd -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/security/opasswd -p wa -k identity

# Monitor network configuration
-a always,exit -F arch=b64 -S sethostname -S setdomainname -k system-locale
-w /etc/issue -p wa -k system-locale
-w /etc/issue.net -p wa -k system-locale
-w /etc/hosts -p wa -k system-locale
-w /etc/network -p wa -k system-locale

# Monitor privileged commands
-w /bin/su -p x -k privileged
-w /usr/bin/sudo -p x -k privileged
-w /etc/sudoers -p wa -k privileged

# Monitor file deletions
-a always,exit -F arch=b64 -S unlink -S unlinkat -S rename -S renameat -F auid>=1000 -F auid!=4294967295 -k delete
      `;
      
      await server.executeCommand(`echo '${auditRules}' | sudo tee /etc/audit/rules.d/audit.rules`);
      await server.executeCommand('sudo augenrules --load');
      await server.executeCommand('sudo systemctl restart auditd');
      
      // 5. Access, Authentication and Authorization
      // Configure PAM password policy
      await server.executeCommand('sudo apt-get install -y libpam-pwquality');
      
      const pwqualityConf = `
minlen = 14
dcredit = -1
ucredit = -1
ocredit = -1
lcredit = -1
minclass = 4
maxrepeat = 2
maxsequence = 3
      `;
      
      await server.executeCommand(`echo '${pwqualityConf}' | sudo tee /etc/security/pwquality.conf`);
      
      // Set password aging
      await server.executeCommand('sudo sed -i "s/^PASS_MAX_DAYS.*/PASS_MAX_DAYS   90/" /etc/login.defs');
      await server.executeCommand('sudo sed -i "s/^PASS_MIN_DAYS.*/PASS_MIN_DAYS   7/" /etc/login.defs');
      await server.executeCommand('sudo sed -i "s/^PASS_WARN_AGE.*/PASS_WARN_AGE   14/" /etc/login.defs');
      
      // 6. System Maintenance
      // Configure automatic security updates
      await server.executeCommand('sudo apt-get install -y unattended-upgrades');
      
      const autoUpgrades = `
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "02:00";
      `;
      
      await server.executeCommand(`echo '${autoUpgrades}' | sudo tee /etc/apt/apt.conf.d/50unattended-upgrades`);
      
      // Enable automatic updates
      await server.executeCommand('echo "APT::Periodic::Update-Package-Lists \"1\";" | sudo tee /etc/apt/apt.conf.d/20auto-upgrades');
      await server.executeCommand('echo "APT::Periodic::Unattended-Upgrade \"1\";" | sudo tee -a /etc/apt/apt.conf.d/20auto-upgrades');
      
      // 7. File Permissions
      // Set strict permissions on critical files
      await server.executeCommand('sudo chmod 644 /etc/passwd');
      await server.executeCommand('sudo chmod 640 /etc/shadow');
      await server.executeCommand('sudo chmod 644 /etc/group');
      await server.executeCommand('sudo chmod 640 /etc/gshadow');
      
      // Remove SUID/SGID from unnecessary binaries
      await server.executeCommand('sudo find / -type f \\( -perm -4000 -o -perm -2000 \\) -exec ls -l {} \\;');
      
      // 8. SSH Hardening
      const sshdConfig = `
Protocol 2
Port 2222
ListenAddress 0.0.0.0
PermitRootLogin no
MaxAuthTries 3
MaxSessions 2
ClientAliveInterval 300
ClientAliveCountMax 2
PasswordAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
ChallengeResponseAuthentication no
KerberosAuthentication no
GSSAPIAuthentication no
X11Forwarding no
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
AllowUsers admin deploy
      `;
      
      await server.executeCommand(`echo '${sshdConfig}' | sudo tee /etc/ssh/sshd_config`);
      await server.executeCommand('sudo systemctl restart sshd');
      
      // 9. Firewall Configuration
      await server.executeCommand('sudo apt-get install -y ufw');
      await server.executeCommand('sudo ufw default deny incoming');
      await server.executeCommand('sudo ufw default allow outgoing');
      await server.executeCommand('sudo ufw allow 2222/tcp');
      await server.executeCommand('sudo ufw allow 80/tcp');
      await server.executeCommand('sudo ufw allow 443/tcp');
      await server.executeCommand('sudo ufw --force enable');
      
      // 10. Kernel Hardening
      await server.executeCommand('sudo apt-get install -y linux-hardened');
      
      // Configure kernel parameters
      await server.executeCommand('sudo sysctl -w kernel.kptr_restrict=2');
      await server.executeCommand('sudo sysctl -w kernel.dmesg_restrict=1');
      await server.executeCommand('sudo sysctl -w kernel.yama.ptrace_scope=2');
      await server.executeCommand('sudo sysctl -w vm.mmap_rnd_bits=28');
      await server.executeCommand('sudo sysctl -w vm.mmap_rnd_compat_bits=16');
      
      // 11. Run CIS audit
      await server.executeCommand('sudo apt-get install -y lynis');
      const lynisReport = await server.executeCommand('sudo lynis audit system --quick');
      expect(lynisReport).toContain('Hardening index');
      
      // Cleanup
      await server.executeCommand('sudo ufw disable');
    });

    it('should implement intrusion detection with AIDE and audit monitoring', async () => {
      const server = new LinuxServer('linux-server', 'IDS-SRV');
      
      // Install AIDE (Advanced Intrusion Detection Environment)
      await server.executeCommand('sudo apt-get install -y aide aide-common');
      
      // Initialize AIDE database
      await server.executeCommand('sudo aideinit');
      await server.executeCommand('sudo mv /var/lib/aide/aide.db.new /var/lib/aide/aide.db');
      
      // Create custom AIDE configuration
      const aideConf = `
# Basic configuration
@@define DBDIR /var/lib/aide
@@define LOGDIR /var/log/aide

database=file:@@{DBDIR}/aide.db.gz
database_out=file:@@{DBDIR}/aide.db.new.gz
gzip_dbout=yes

# Verbosity level
verbose=5

# Logging
report_url=file:@@{LOGDIR}/aide.log
report_url=stdout

# Rules
# Normal integrity check
ALL = p+i+n+u+g+s+m+c+acl+selinux+xattrs+sha512

# Files that should not change
/etc/hosts$ ALL
/etc/passwd$ ALL
/etc/group$ ALL
/etc/shadow$ ALL
/etc/gshadow$ ALL
/etc/sudoers$ ALL

# Directories
/etc/ ALL
/bin/ ALL
/sbin/ ALL
/usr/bin/ ALL
/usr/sbin/ ALL

# Exclusions
!/proc
!/sys
!/tmp
!/var/tmp
!/var/run
!/var/log
      `;
      
      await server.executeCommand(`echo '${aideConf}' | sudo tee /etc/aide/aide.conf`);
      
      // Update AIDE database
      await server.executeCommand('sudo aide --update');
      await server.executeCommand('sudo mv /var/lib/aide/aide.db.new.gz /var/lib/aide/aide.db.gz');
      
      // Run integrity check
      const aideCheck = await server.executeCommand('sudo aide --check');
      expect(aideCheck).toContain('AIDE found');
      
      // Configure daily checks
      await server.executeCommand('sudo cp /usr/share/aide/config/cron.daily/aide /etc/cron.daily/');
      await server.executeCommand('sudo chmod +x /etc/cron.daily/aide');
      
      // Install and configure osquery for real-time monitoring
      await server.executeCommand('sudo apt-get install -y osquery');
      
      const osqueryConf = `
{
  "options": {
    "host_identifier": "hostname",
    "schedule_splay_percent": 10,
    "disable_tables": "chrome_extensions",
    "logger_tls_endpoint": "/api/v1/log",
    "logger_tls_period": 60
  },
  "schedule": {
    "system_info": {
      "query": "SELECT hostname, cpu_brand, physical_memory FROM system_info;",
      "interval": 3600
    },
    "processes": {
      "query": "SELECT pid, name, path, cmdline FROM processes;",
      "interval": 300
    },
    "listening_ports": {
      "query": "SELECT pid, port, protocol, family, address FROM listening_ports;",
      "interval": 300
    },
    "user_logins": {
      "query": "SELECT type, user, time FROM last;",
      "interval": 300
    }
  },
  "decorators": {
    "load": [
      "SELECT hostname FROM system_info;",
      "SELECT user FROM logged_in_users ORDER BY time DESC LIMIT 1;"
    ]
  }
}
      `;
      
      await server.executeCommand(`echo '${osqueryConf}' | sudo tee /etc/osquery/osquery.conf`);
      
      // Start osquery
      await server.executeCommand('sudo systemctl start osqueryd');
      await server.executeCommand('sudo systemctl enable osqueryd');
      
      // Run osquery queries
      const processes = await server.executeCommand('sudo osqueryi --json "SELECT * FROM processes WHERE name LIKE \'%bash%\'"');
      expect(processes).toContain('pid');
      
      const listening = await server.executeCommand('sudo osqueryi --json "SELECT * FROM listening_ports WHERE port < 1024"');
      expect(listening).toContain('port');
      
      // Configure auditbeat for centralized logging
      await server.executeCommand('sudo apt-get install -y auditbeat');
      
      const auditbeatConf = `
auditbeat.modules:
- module: auditd
  audit_rules: |
    -a always,exit -F arch=b64 -S execve -k exec
    
- module: file_integrity
  paths:
    - /bin
    - /usr/bin
    - /sbin
    - /usr/sbin
    - /etc

output.elasticsearch:
  hosts: ["elasticsearch:9200"]
  username: "elastic"
  password: "changeme"
      `;
      
      await server.executeCommand(`echo '${auditbeatConf}' | sudo tee /etc/auditbeat/auditbeat.yml`);
      await server.executeCommand('sudo systemctl start auditbeat');
      
      // Install and configure Wazuh agent
      await server.executeCommand('sudo apt-get install -y wazuh-agent');
      
      const wazuhConf = `
<ossec_config>
  <client>
    <server-ip>wazuh.server</server-ip>
    <port>1514</port>
    <protocol>tcp</protocol>
    <notify_time>60</notify_time>
    <time-reconnect>300</time-reconnect>
  </client>
  
  <syscheck>
    <disabled>no</disabled>
    <frequency>43200</frequency>
    <scan_on_start>yes</scan_on_start>
    <directories check_all="yes">/etc,/usr/bin,/usr/sbin</directories>
    <ignore>/etc/mtab</ignore>
    <ignore>/etc/hosts.deny</ignore>
    <ignore>/etc/mail/statistics</ignore>
  </syscheck>
  
  <rootcheck>
    <disabled>no</disabled>
    <check_files>yes</check_files>
    <check_trojans>yes</check_trojans>
    <check_dev>yes</check_dev>
    <check_sys>yes</check_sys>
    <check_pids>yes</check_pids>
    <check_ports>yes</check_ports>
    <check_if>yes</check_if>
  </rootcheck>
</ossec_config>
      `;
      
      await server.executeCommand(`echo '${wazuhConf}' | sudo tee /var/ossec/etc/ossec.conf`);
      await server.executeCommand('sudo systemctl start wazuh-agent');
      
      // Run rkhunter (Rootkit Hunter)
      await server.executeCommand('sudo apt-get install -y rkhunter');
      await server.executeCommand('sudo rkhunter --update');
      const rkhunterCheck = await server.executeCommand('sudo rkhunter --check --skip-keypress');
      expect(rkhunterCheck).toContain('Rootkit check');
      
      // Run chkrootkit
      await server.executeCommand('sudo apt-get install -y chkrootkit');
      const chkrootkitCheck = await server.executeCommand('sudo chkrootkit');
      expect(chkrootkitCheck).toContain('not infected');
      
      // Monitor log files with logwatch
      await server.executeCommand('sudo apt-get install -y logwatch');
      const logwatchReport = await server.executeCommand('sudo logwatch --detail High --range Today --output mail');
      expect(logwatchReport).toContain('Logwatch');
      
      // Cleanup
      await server.executeCommand('sudo systemctl stop osqueryd');
      await server.executeCommand('sudo systemctl stop auditbeat');
      await server.executeCommand('sudo systemctl stop wazuh-agent');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: Backup, Snapshot & Disaster Recovery
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Backup, Snapshot & Disaster Recovery', () => {

  // B-UBU-01: Advanced Backup Strategies
  describe('B-UBU-01: Advanced Backup Strategies', () => {
    it('should implement comprehensive backup strategy with multiple methods', async () => {
      const server = new LinuxServer('linux-server', 'BACKUP-SRV');
      
      // 1. rsync based backups
      // Create backup directory structure
      await server.executeCommand('sudo mkdir -p /backup/{daily,weekly,monthly}/{full,incremental}');
      
      // Full backup with rsync
      await server.executeCommand('sudo rsync -avz --delete --exclude="/dev/*" --exclude="/proc/*" --exclude="/sys/*" --exclude="/tmp/*" --exclude="/run/*" --exclude="/mnt/*" --exclude="/media/*" --exclude="lost+found" / /backup/daily/full/');
      
      // Incremental backup with hard links
      await server.executeCommand('sudo rsync -avz --link-dest=/backup/daily/full/ --exclude="/dev/*" --exclude="/proc/*" --exclude="/sys/*" --exclude="/tmp/*" --exclude="/run/*" --exclude="/mnt/*" --exclude="/media/*" --exclude="lost+found" / /backup/daily/incremental/$(date +%Y%m%d)/');
      
      // 2. tar based backups with compression
      // Full system backup
      await server.executeCommand('sudo tar -czp --exclude=/backup --exclude=/dev --exclude=/proc --exclude=/sys --exclude=/tmp --exclude=/run --exclude=/mnt --exclude=/media --exclude=/var/cache --exclude=/var/tmp -f /backup/full-backup-$(date +%Y%m%d).tar.gz /');
      
      // Incremental backup using find and tar
      await server.executeCommand('sudo find /etc -newer /backup/timestamp -type f -print0 | sudo tar -czf /backup/incremental-etc-$(date +%Y%m%d).tar.gz --null -T -');
      await server.executeCommand('sudo touch /backup/timestamp');
      
      // 3. dd based disk cloning
      await server.executeCommand('sudo dd if=/dev/sda of=/backup/disk-image.img bs=4M status=progress');
      
      // Compress disk image
      await server.executeCommand('sudo gzip /backup/disk-image.img');
      
      // 4. borg backup (deduplication)
      await server.executeCommand('sudo apt-get install -y borgbackup');
      
      // Initialize borg repository
      await server.executeCommand('borg init --encryption=repokey /backup/borg-repo');
      
      // Create backup
      await server.executeCommand('borg create --stats --progress /backup/borg-repo::system-{now} /etc /home /var/www');
      
      // List backups
      const borgList = await server.executeCommand('borg list /backup/borg-repo');
      expect(borgList).toContain('system-');
      
      // Extract backup
      await server.executeCommand('borg extract /backup/borg-repo::system-* /tmp/restore');
      
      // 5. duplicity backup (encrypted cloud backup)
      await server.executeCommand('sudo apt-get install -y duplicity');
      
      // Backup to local directory
      await server.executeCommand('sudo duplicity full --encrypt-key "BackupKey" /etc file:///backup/duplicity');
      
      // Incremental backup
      await server.executeCommand('sudo duplicity incremental --encrypt-key "BackupKey" /etc file:///backup/duplicity');
      
      // List backup files
      const duplicityList = await server.executeCommand('sudo duplicity list-current-files file:///backup/duplicity');
      expect(duplicityList).toContain('/etc');
      
      // 6. Amanda backup system
      await server.executeCommand('sudo apt-get install -y amanda-server amanda-client');
      
      // Configure Amanda
      await server.executeCommand('sudo cp /usr/share/doc/amanda-server/examples/example.conf /etc/amanda/DailySet1/amanda.conf');
      
      // Create disklist
      const disklist = `
localhost /etc comp-root tar
localhost /home comp-user tar
      `;
      
      await server.executeCommand(`echo '${disklist}' | sudo tee /etc/amanda/DailySet1/disklist`);
      
      // Run Amanda backup
      await server.executeCommand('sudo amdump DailySet1');
      
      // 7. Backup verification
      // Verify tar backup
      await server.executeCommand('tar -tzf /backup/full-backup-*.tar.gz | head -20');
      
      // Verify rsync backup
      await server.executeCommand('sudo rsync -n -avc /backup/daily/full/etc/passwd /tmp/test/');
      
      // Check backup integrity
      await server.executeCommand('sha256sum /backup/full-backup-*.tar.gz > /backup/checksums.txt');
      
      // 8. Automated backup script
      const backupScript = `
#!/bin/bash
BACKUP_DIR="/backup"
DATE=$(date +%Y%m%d)
RETENTION_DAYS=30

# MySQL backup
mysqldump --all-databases | gzip > $BACKUP_DIR/mysql-$DATE.sql.gz

# PostgreSQL backup
pg_dumpall | gzip > $BACKUP_DIR/postgres-$DATE.sql.gz

# Cleanup old backups
find $BACKUP_DIR -name "*.gz" -mtime +$RETENTION_DAYS -delete
      `;
      
      await server.executeCommand(`echo '${backupScript}' | sudo tee /usr/local/bin/backup.sh`);
      await server.executeCommand('sudo chmod +x /usr/local/bin/backup.sh');
      
      // Schedule backup with cron
      await server.executeCommand('echo "0 2 * * * root /usr/local/bin/backup.sh" | sudo tee /etc/cron.d/backup');
      
      // 9. Test restore procedures
      // Test tar restore
      await server.executeCommand('mkdir -p /tmp/restore-test');
      await server.executeCommand('tar -xzf /backup/full-backup-*.tar.gz -C /tmp/restore-test --strip-components=1');
      
      // Test rsync restore
      await server.executeCommand('sudo rsync -av /backup/daily/full/etc/ /tmp/restore-etc/');
      
      // 10. Monitor backup status
      const backupSize = await server.executeCommand('du -sh /backup');
      expect(backupSize).toContain('G') || expect(backupSize).toContain('M');
      
      const backupCount = await server.executeCommand('find /backup -name "*.tar.gz" -o -name "*.sql.gz" | wc -l');
      expect(parseInt(backupCount)).toBeGreaterThan(0);
      
      // Cleanup
      await server.executeCommand('sudo rm -rf /backup /tmp/restore /tmp/restore-test /tmp/restore-etc');
    });

    it('should implement snapshot-based recovery with LVM and Btrfs', async () => {
      const server = new LinuxServer('linux-server', 'SNAPSHOT-SRV');
      
      // 1. LVM Snapshots
      // Create LVM volume group and logical volume
      await server.executeCommand('sudo pvcreate /dev/sdb');
      await server.executeCommand('sudo vgcreate vg_snap /dev/sdb');
      await server.executeCommand('sudo lvcreate -L 20G -n lv_root vg_snap');
      await server.executeCommand('sudo mkfs.ext4 /dev/vg_snap/lv_root');
      
      // Create snapshot
      await server.executeCommand('sudo lvcreate -L 5G -s -n root_snapshot /dev/vg_snap/lv_root');
      
      // Mount original and snapshot
      await server.executeCommand('sudo mkdir -p /mnt/original /mnt/snapshot');
      await server.executeCommand('sudo mount /dev/vg_snap/lv_root /mnt/original');
      await server.executeCommand('sudo mount /dev/vg_snap/root_snapshot /mnt/snapshot');
      
      // Verify snapshot
      const snapshotStatus = await server.executeCommand('sudo lvs -o name,attr,size,snap_percent');
      expect(snapshotStatus).toContain('root_snapshot');
      expect(snapshotStatus).toContain('s');
      
      # Test snapshot usage
      await server.executeCommand('sudo touch /mnt/original/testfile');
      const snapshotTest = await server.executeCommand('ls /mnt/snapshot/testfile');
      expect(snapshotTest).toBe('');
      
      # Merge snapshot
      await server.executeCommand('sudo lvconvert --merge /dev/vg_snap/root_snapshot');
      
      # 2. Btrfs Snapshots
      # Create Btrfs filesystem
      await server.executeCommand('sudo mkfs.btrfs -f /dev/sdc');
      await server.executeCommand('sudo mkdir -p /btrfs');
      await server.executeCommand('sudo mount /dev/sdc /btrfs');
      
      # Create subvolume
      await server.executeCommand('sudo btrfs subvolume create /btrfs/data');
      
      # Create read-write snapshot
      await server.executeCommand('sudo btrfs subvolume snapshot /btrfs/data /btrfs/data-snapshot-$(date +%Y%m%d)');
      
      # Create read-only snapshot
      await server.executeCommand('sudo btrfs subvolume snapshot -r /btrfs/data /btrfs/data-ro-snapshot-$(date +%Y%m%d)');
      
      # List snapshots
      const btrfsSnapshots = await server.executeCommand('sudo btrfs subvolume list /btrfs');
      expect(btrfsSnapshots).toContain('data-snapshot');
      
      # Send snapshot to another location
      await server.executeCommand('sudo btrfs send /btrfs/data-ro-snapshot-* | sudo btrfs receive /backup/');
      
      # Delete snapshot
      await server.executeCommand('sudo btrfs subvolume delete /btrfs/data-snapshot-*');
      
      # 3. ZFS Snapshots
      await server.executeCommand('sudo apt-get install -y zfsutils-linux');
      
      # Create ZFS pool
      await server.executeCommand('sudo zpool create tank /dev/sdd');
      
      # Create dataset
      await server.executeCommand('sudo zfs create tank/data');
      
      # Create snapshot
      await server.executeCommand('sudo zfs snapshot tank/data@$(date +%Y%m%d)');
      
      # Clone snapshot
      await server.executeCommand('sudo zfs clone tank/data@$(date +%Y%m%d) tank/data-clone');
      
      # Rollback to snapshot
      await server.executeCommand('sudo zfs rollback tank/data@$(date +%Y%m%d)');
      
      # Send snapshot to file
      await server.executeCommand('sudo zfs send tank/data@$(date +%Y%m%d) | gzip > /backup/zfs-snapshot.gz');
      
      # 4. Automated snapshot management
      const snapshotScript = `
#!/bin/bash
# LVM snapshots
lvcreate -L 2G -s -n root_snap_$(date +%Y%m%d) /dev/vg_snap/lv_root

# Btrfs snapshots
btrfs subvolume snapshot -r /btrfs/data /btrfs/snapshots/data_$(date +%Y%m%d_%H%M%S)

# ZFS snapshots
zfs snapshot tank/data@auto_$(date +%Y%m%d)

# Cleanup old snapshots (keep 7 days)
find /btrfs/snapshots -name "data_*" -mtime +7 -exec btrfs subvolume delete {} \\;
zfs list -t snapshot -o name | grep auto_ | sort -r | tail -n +8 | xargs -n1 zfs destroy
      `;
      
      await server.executeCommand(`echo '${snapshotScript}' | sudo tee /usr/local/bin/create-snapshots.sh`);
      await server.executeCommand('sudo chmod +x /usr/local/bin/create-snapshots.sh');
      
      # Schedule snapshots
      await server.executeCommand('echo "0 */4 * * * root /usr/local/bin/create-snapshots.sh" | sudo tee /etc/cron.d/snapshots');
      
      # 5. Disaster recovery test
      # Simulate data loss
      await server.executeCommand('sudo rm -rf /mnt/original/important-data')
      
      # Restore from LVM snapshot
      await server.executeCommand('sudo umount /mnt/original')
      await server.executeCommand('sudo lvconvert --merge /dev/vg_snap/root_snapshot')
      await server.executeCommand('sudo mount /dev/vg_snap/lv_root /mnt/original')
      
      # Verify restoration
      const restoredData = await server.executeCommand('ls /mnt/original/important-data')
      expect(restoredData).toContain('file') || expect(restoredData).toBe('')
      
      # Cleanup
      await server.executeCommand('sudo umount /mnt/original /mnt/snapshot /btrfs')
      await server.executeCommand('sudo vgremove -f vg_snap')
      await server.executeCommand('sudo pvremove /dev/sdb /dev/sdc /dev/sdd')
      await server.executeCommand('sudo rm -rf /backup')
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: Container & Virtualization Integration
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: Container & Virtualization Integration', () => {

  // C-UBU-01: Docker Container Management
  describe('C-UBU-01: Docker Container Management', () => {
    it('should implement advanced Docker container management with security', async () => {
      const server = new LinuxServer('linux-server', 'DOCKER-SRV');
      
      // Install Docker
      await server.executeCommand('sudo apt-get install -y docker.io docker-compose containerd runc');
      
      # Configure Docker daemon with security options
      const daemonJson = `
{
  "data-root": "/var/lib/docker",
  "exec-opts": ["native.cgroupdriver=systemd"],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  },
  "storage-driver": "overlay2",
  "storage-opts": [
    "overlay2.override_kernel_check=true"
  ],
  "userns-remap": "default",
  "live-restore": true,
  "icc": false,
  "userland-proxy": false,
  "no-new-privileges": true,
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 65535,
      "Soft": 65535
    }
  }
}
      `;
      
      await server.executeCommand(`echo '${daemonJson}' | sudo tee /etc/docker/daemon.json`);
      await server.executeCommand('sudo systemctl restart docker');
      
      # Create Docker network
      await server.executeCommand('sudo docker network create --driver bridge --subnet=172.20.0.0/16 --ip-range=172.20.5.0/24 --gateway=172.20.0.1 app-network');
      
      # Create Docker volumes
      await server.executeCommand('sudo docker volume create db-data');
      await server.executeCommand('sudo docker volume create app-data');
      await server.executeCommand('sudo docker volume create logs');
      
      # Run container with security constraints
      await server.executeCommand('sudo docker run -d \
        --name secure-nginx \
        --network app-network \
        --ip 172.20.5.10 \
        --memory="512m" \
        --memory-swap="1g" \
        --cpus="1.5" \
        --pids-limit="100" \
        --read-only \
        --tmpfs /tmp:rw,noexec,nosuid,size=65536k \
        --security-opt="no-new-privileges" \
        --security-opt="seccomp=unconfined" \
        --cap-drop ALL \
        --cap-add NET_BIND_SERVICE \
        --ulimit nofile=1024:1024 \
        -v app-data:/usr/share/nginx/html:ro \
        -v logs:/var/log/nginx \
        -p 80:80 \
        nginx:alpine');
      
      # Run container with user namespace
      await server.executeCommand('sudo docker run -d --name userns --userns=host alpine sleep 3600');
      
      # Create Docker Compose file
      const composeFile = `
version: '3.8'
services:
  web:
    image: nginx:alpine
    container_name: nginx
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    networks:
      - frontend
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M
    security_opt:
      - no-new-privileges:true
    read_only: true
    
  db:
    image: postgres:13
    container_name: postgres
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: securepassword
      POSTGRES_DB: appdb
    volumes:
      - db-data:/var/lib/postgresql/data
    networks:
      - backend
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G

  app:
    image: node:14
    container_name: nodeapp
    restart: unless-stopped
    working_dir: /app
    volumes:
      - ./app:/app
    networks:
      - frontend
      - backend
    depends_on:
      - db

networks:
  frontend:
    driver: bridge
    ipam:
      config:
        - subnet: 172.21.0.0/16
  backend:
    driver: bridge
    ipam:
      config:
        - subnet: 172.22.0.0/16

volumes:
  db-data:
    driver: local
      `;
      
      await server.executeCommand(`echo '${composeFile}' > docker-compose.yml`);
      await server.executeCommand('sudo docker-compose up -d');
      
      # Monitor containers
      const containers = await server.executeCommand('sudo docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"');
      expect(containers).toContain('nginx');
      expect(containers).toContain('postgres');
      
      # Check container logs
      const logs = await server.executeCommand('sudo docker logs nginx --tail 10');
      expect(logs).toContain('started') || expect(logs).toBe('');
      
      # Inspect container
      const inspect = await server.executeCommand('sudo docker inspect nginx --format "{{.State.Status}}"');
      expect(inspect).toContain('running');
      
      # Check resource usage
      const stats = await server.executeCommand('sudo docker stats --no-stream');
      expect(stats).toContain('CPU %');
      expect(stats).toContain('MEM USAGE');
      
      # Execute command in container
      const execOutput = await server.executeCommand('sudo docker exec nginx nginx -t');
      expect(execOutput).toContain('successful') || expect(execOutput).toContain('test is successful');
      
      # Create image from container
      await server.executeCommand('sudo docker commit nginx nginx-custom:latest');
      
      # Save and load image
      await server.executeCommand('sudo docker save nginx-custom:latest | gzip > nginx-custom.tar.gz');
      await server.executeCommand('sudo docker load < nginx-custom.tar.gz');
      
      # Cleanup
      await server.executeCommand('sudo docker-compose down -v');
      await server.executeCommand('sudo docker rm -f secure-nginx userns');
      await server.executeCommand('sudo docker network rm app-network');
      await server.executeCommand('sudo docker volume rm db-data app-data logs');
      await server.executeCommand('sudo systemctl stop docker');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 8: Performance Monitoring & Tuning
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: Performance Monitoring & Tuning', () => {

  // M-UBU-01: Advanced Performance Monitoring
  describe('M-UBU-01: Advanced Performance Monitoring', () => {
    it('should implement comprehensive performance monitoring and tuning', async () => {
      const server = new LinuxServer('linux-server', 'PERF-SRV');
      
      # 1. System Monitoring Tools
      # Install monitoring tools
      await server.executeCommand('sudo apt-get install -y htop iotop iftop nethogs nmon dstat sysstat bpftrace perf-tools-unstable');
      
      # Monitor CPU with mpstat
      const mpstatOutput = await server.executeCommand('mpstat 1 3');
      expect(mpstatOutput).toContain('CPU');
      expect(mpstatOutput).toContain('%usr');
      
      # Monitor memory with vmstat
      const vmstatOutput = await server.executeCommand('vmstat 1 3');
      expect(vmstatOutput).toContain('memory');
      expect(vmstatOutput).toContain('swap');
      
      # Monitor I/O with iostat
      const iostatOutput = await server.executeCommand('iostat -dx 1 3');
      expect(iostatOutput).toContain('Device');
      expect(iostatOutput).toContain('await');
      
      # 2. Process Monitoring
      # Show process tree
      const pstreeOutput = await server.executeCommand('pstree -p');
      expect(pstreeOutput).toContain('systemd');
      
      # Show resource usage by process
      const pidstatOutput = await server.executeCommand('pidstat 1 3');
      expect(pidstatOutput).toContain('PID');
      expect(pidstatOutput).toContain('%CPU');
      
      # 3. Network Monitoring
      # Monitor network with ss
      const ssOutput = await server.executeCommand('ss -tulpn');
      expect(ssOutput).toContain('LISTEN');
      
      # Monitor network with netstat
      const netstatOutput = await server.executeCommand('netstat -tulpn');
      expect(netstatOutput).toContain('Active Internet connections');
      
      # Monitor bandwidth with iftop
      await server.executeCommand('timeout 5 iftop -i eth0');
      
      # 4. Disk Monitoring
      # Check disk usage
      const dfOutput = await server.executeCommand('df -hT');
      expect(dfOutput).toContain('Filesystem');
      expect(dfOutput).toContain('Type');
      
      # Check inode usage
      const inodeOutput = await server.executeCommand('df -i');
      expect(inodeOutput).toContain('Inodes');
      
      # Monitor disk I/O with iotop
      await server.executeCommand('timeout 5 iotop -o');
      
      # 5. Log Monitoring
      # Monitor system logs in real-time
      await server.executeCommand('timeout 5 tail -f /var/log/syslog');
      
      # Show kernel messages
      const dmesgOutput = await server.executeCommand('dmesg | tail -20');
      expect(dmesgOutput).toContain('kernel');
      
      # 6. Performance Profiling
      # Use perf for CPU profiling
      await server.executeCommand('sudo perf record -F 99 -a -g -- sleep 5');
      await server.executeCommand('sudo perf report --stdio | head -50');
      
      # Use strace for system call tracing
      const straceOutput = await server.executeCommand('strace -c ls >/dev/null');
      expect(straceOutput).toContain('calls');
      
      # Use ltrace for library call tracing
      const ltraceOutput = await server.executeCommand('ltrace -c ls >/dev/null 2>&1');
      
      # 7. System Tuning
      # Tune kernel parameters
      const tuningParams = `
# Increase TCP buffer sizes
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# Increase connection tracking
net.netfilter.nf_conntrack_max = 262144
net.netfilter.nf_conntrack_tcp_timeout_established = 86400

# Increase file descriptors
fs.file-max = 2097152
fs.nr_open = 2097152

# Increase ephemeral port range
net.ipv4.ip_local_port_range = 10000 65535

# Reduce TIME_WAIT socket timeout
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_tw_reuse = 1
      `;
      
      await server.executeCommand(`echo '${tuningParams}' | sudo tee /etc/sysctl.d/99-performance.conf`);
      await server.executeCommand('sudo sysctl -p /etc/sysctl.d/99-performance.conf');
      
      # Tune disk scheduler
      await server.executeCommand('echo deadline | sudo tee /sys/block/sda/queue/scheduler');
      
      # Tune swappiness
      await server.executeCommand('echo 10 | sudo tee /proc/sys/vm/swappiness');
      
      # Tune dirty ratios
      await server.executeCommand('echo 10 | sudo tee /proc/sys/vm/dirty_background_ratio');
      await server.executeCommand('echo 20 | sudo tee /proc/sys/vm/dirty_ratio');
      
      # 8. Benchmarking
      # CPU benchmark
      const cpuBench = await server.executeCommand('sysbench cpu --cpu-max-prime=20000 run');
      expect(cpuBench).toContain('total time');
      
      # Memory benchmark
      const memBench = await server.executeCommand('sysbench memory --memory-block-size=1K --memory-total-size=10G run');
      expect(memBench).toContain('Operations');
      
      # Disk benchmark
      const diskBench = await server.executeCommand('fio --name=randwrite --ioengine=libaio --iodepth=1 --rw=randwrite --bs=4k --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting');
      expect(diskBench).toContain('IOPS');
      
      # Network benchmark
      await server.executeCommand('iperf3 -s -D');
      const netBench = await server.executeCommand('iperf3 -c localhost -t 5');
      expect(netBench).toContain('Gbits/sec') || expect(netBench).toContain('Mbits/sec');
      
      # 9. Resource Limits
      # Set ulimits
      await server.executeCommand('ulimit -n 65535');
      await server.executeCommand('ulimit -u unlimited');
      
      # 10. Monitoring Dashboard
      # Install and configure netdata
      await server.executeCommand('bash <(curl -Ss https://my-netdata.io/kickstart.sh) --non-interactive');
      
      const netdataStatus = await server.executeCommand('sudo systemctl status netdata');
      expect(netdataStatus).toContain('active (running)');
      
      # Install and configure Prometheus node exporter
      await server.executeCommand('sudo apt-get install -y prometheus-node-exporter');
      
      const nodeExporterStatus = await server.executeCommand('sudo systemctl status prometheus-node-exporter');
      expect(nodeExporterStatus).toContain('active (running)');
      
      # Cleanup
      await server.executeCommand('sudo systemctl stop netdata');
      await server.executeCommand('sudo systemctl stop prometheus-node-exporter');
      await server.executeCommand('sudo rm -f /etc/sysctl.d/99-performance.conf');
    });
  });
});
