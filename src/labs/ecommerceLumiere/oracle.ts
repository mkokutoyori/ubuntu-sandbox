import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { ARCHIVELOG_SCRIPT, HEALTH_SCRIPT, SCHEMA_SCRIPT, SCRIPT_DIR, SEED_SCRIPT } from './oracleScripts';

export async function createOracleOsUser(bench: LabWorkbench, server: Equipment): Promise<void> {
  await bench.shell(
    server,
    'sudo groupadd -g 54321 oinstall',
    'sudo groupadd -g 54322 dba',
    'sudo useradd -u 54321 -g oinstall -G dba -m -s /bin/bash oracle',
  );
}

export async function configureBackupServer(bench: LabWorkbench, server: Equipment, exportPath: string, clients: readonly string[]): Promise<void> {
  await bench.shell(
    server,
    `sudo mkdir -p ${exportPath}`,
    `sudo chown -R oracle:oinstall ${exportPath}`,
    `sudo chmod 775 ${exportPath}`,
  );
  await bench.writeFile(server, '/etc/exports', `${exportPath} ${clients.join(' ')}`);
  await bench.shell(server, 'sudo systemctl start rpcbind', 'sudo systemctl enable --now nfs-kernel-server', 'sudo exportfs -ra');
}

export async function declareBackupShare(bench: LabWorkbench, db: Equipment, server: string, exportPath: string, mountPoint: string): Promise<void> {
  await bench.shell(db, `sudo mkdir -p ${mountPoint}`, `echo "${server}:${exportPath} ${mountPoint} nfs defaults 0 0" | sudo tee -a /etc/fstab`);
}

export async function shipScripts(bench: LabWorkbench, db: Equipment): Promise<void> {
  await bench.shell(db, `sudo mkdir -p ${SCRIPT_DIR}`);
  await bench.writeFile(db, `${SCRIPT_DIR}/01_schema.sql`, SCHEMA_SCRIPT);
  await bench.writeFile(db, `${SCRIPT_DIR}/02_seed.sql`, SEED_SCRIPT);
  await bench.writeFile(db, `${SCRIPT_DIR}/03_archivelog.sql`, ARCHIVELOG_SCRIPT);
  await bench.writeFile(db, `${SCRIPT_DIR}/health.sql`, HEALTH_SCRIPT);
}

export async function loadShopSchema(bench: LabWorkbench, db: Equipment): Promise<void> {
  await bench.shell(
    db,
    `sqlplus -s / as sysdba @${SCRIPT_DIR}/01_schema.sql`,
    `sqlplus -s / as sysdba @${SCRIPT_DIR}/02_seed.sql`,
  );
}
