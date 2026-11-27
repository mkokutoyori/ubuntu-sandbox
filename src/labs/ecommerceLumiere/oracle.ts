import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { ARCHIVELOG_SCRIPT, HEALTH_SCRIPT, SCHEMA_SCRIPT, SCRIPT_DIR, SEED_SCRIPT } from './oracleScripts';
import { DR, HQ, INTERNAL_DOMAIN } from './plan';

export async function configureBackupServer(bench: LabWorkbench, server: Equipment, exportPath: string, clients: string): Promise<void> {
  await bench.shell(
    server,
    `sudo mkdir -p ${exportPath}`,
    `sudo chown -R oracle:oinstall ${exportPath}`,
    `sudo chmod 775 ${exportPath}`,
  );
  await bench.writeFile(server, '/etc/exports', `${exportPath} ${clients}(rw,sync,no_root_squash)`);
  await bench.shell(server, 'sudo systemctl start rpcbind', 'sudo systemctl enable --now nfs-kernel-server', 'sudo exportfs -ra');
}

export async function mountBackupShare(bench: LabWorkbench, db: Equipment, server: string, exportPath: string, mountPoint: string): Promise<void> {
  await bench.shell(db, `sudo mkdir -p ${mountPoint}`, `sudo mount -t nfs ${server}:${exportPath} ${mountPoint}`);
  await bench.shell(db, `echo "${server}:${exportPath} ${mountPoint} nfs defaults 0 0" | sudo tee -a /etc/fstab`);
}

export async function shipScripts(bench: LabWorkbench, db: Equipment): Promise<void> {
  await bench.shell(db, `sudo mkdir -p ${SCRIPT_DIR}`);
  await bench.writeFile(db, `${SCRIPT_DIR}/01_schema.sql`, SCHEMA_SCRIPT);
  await bench.writeFile(db, `${SCRIPT_DIR}/02_seed.sql`, SEED_SCRIPT);
  await bench.writeFile(db, `${SCRIPT_DIR}/03_archivelog.sql`, ARCHIVELOG_SCRIPT);
  await bench.writeFile(db, `${SCRIPT_DIR}/health.sql`, HEALTH_SCRIPT);
}

export function describeEndpoints(): string[] {
  return [`ora-prd.${INTERNAL_DOMAIN}=${HQ.db.oracle}`, `ora-stb.${INTERNAL_DOMAIN}=${DR.db.standby}`, `bkp-hq.${INTERNAL_DOMAIN}=${HQ.db.backup}`, `bkp-dr.${INTERNAL_DOMAIN}=${DR.db.backup}`];
}
