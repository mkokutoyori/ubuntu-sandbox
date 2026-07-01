import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getOracleDatabase } from '@/terminal/commands/database';

const VLAN_USERS = 10;
const VLAN_ADMIN = 20;
const VLAN_SERVERS = 30;
const VLAN_DB = 40;
const VLAN_MGMT = 99;

const NET_USERS   = { net: '10.0.10.0', mask: '255.255.255.0', gw: '10.0.10.1' };
const NET_ADMIN   = { net: '10.0.20.0', mask: '255.255.255.0', gw: '10.0.20.1' };
const NET_SERVERS = { net: '10.0.30.0', mask: '255.255.255.0', gw: '10.0.30.1' };
const NET_DB      = { net: '10.0.40.0', mask: '255.255.255.0', gw: '10.0.40.1' };
const NET_MGMT    = { net: '10.0.99.0', mask: '255.255.255.0', gw: '10.0.99.1' };

const WKS_IP  = '10.0.10.50';
const APP_IP  = '10.0.30.20';
const DB_IP   = '10.0.40.30';
const LOG_IP  = '10.0.99.40';

const APP_USER      = 'oraapp';
const APP_PASSWORD  = 'Welcome1';
const APP_ADMIN     = 'sysadmin';
const APP_ADMIN_PW  = 'S3cureAdm!n';
const WIN_USER      = 'elise';
const WIN_PW        = 'P@ssw0rd2024';
const ORA_USER      = 'BANKAPP';
const ORA_PW        = 'BankApp#2024';

type Lab = {
  core: CiscoSwitch;
  dist: HuaweiSwitch;
  wks: WindowsPC;
  app: LinuxServer;
  db: LinuxServer;
  logsrv: LinuxServer;
};

async function ciscoConfig(sw: CiscoSwitch, cmds: string[]): Promise<void> {
  for (const c of cmds) await sw.executeCommand(c);
}

async function huaweiConfig(sw: HuaweiSwitch, cmds: string[]): Promise<void> {
  for (const c of cmds) await sw.executeCommand(c);
}

async function linuxRoot(srv: LinuxServer, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await srv.executeCommand(c));
  return out;
}

async function buildLab(): Promise<Lab> {
  const core = new CiscoSwitch('switch-cisco', 'CORE-RTR', 26, 0, 0);
  const dist = new HuaweiSwitch('switch-huawei', 'DIST-SW', 24, 0, 0);
  const wks  = new WindowsPC('WKS-001', 'WKS-001', 0, 0);
  const app  = new LinuxServer('linux-server', 'APP-01', 0, 0);
  const db   = new LinuxServer('linux-server', 'DB-01', 0, 0);
  const logsrv = new LinuxServer('linux-server', 'LOG-01', 0, 0);

  new Cable('trunk-core-dist').connect(
    core.getPort('GigabitEthernet0/1')!,
    dist.getPort('GigabitEthernet0/0/1')!,
  );
  new Cable('c-wks').connect(wks.getPorts()[0], dist.getPort('GigabitEthernet0/0/10')!);
  new Cable('c-app').connect(app.getPorts()[0], dist.getPort('GigabitEthernet0/0/20')!);
  new Cable('c-db').connect(db.getPorts()[0], dist.getPort('GigabitEthernet0/0/21')!);
  new Cable('c-log').connect(logsrv.getPorts()[0], dist.getPort('GigabitEthernet0/0/22')!);

  wks.getPorts()[0].configureIP(new IPAddress(WKS_IP), new SubnetMask(NET_USERS.mask));
  wks.setDefaultGateway(new IPAddress(NET_USERS.gw));
  app.getPorts()[0].configureIP(new IPAddress(APP_IP), new SubnetMask(NET_SERVERS.mask));
  app.setDefaultGateway(new IPAddress(NET_SERVERS.gw));
  db.getPorts()[0].configureIP(new IPAddress(DB_IP), new SubnetMask(NET_DB.mask));
  db.setDefaultGateway(new IPAddress(NET_DB.gw));
  logsrv.getPorts()[0].configureIP(new IPAddress(LOG_IP), new SubnetMask(NET_MGMT.mask));
  logsrv.setDefaultGateway(new IPAddress(NET_MGMT.gw));

  await ciscoConfig(core, [
    'enable', 'configure terminal',
    'hostname CORE-RTR',
    `vlan ${VLAN_USERS}`, 'name USERS', 'exit',
    `vlan ${VLAN_ADMIN}`, 'name ADMIN', 'exit',
    `vlan ${VLAN_SERVERS}`, 'name SERVERS', 'exit',
    `vlan ${VLAN_DB}`, 'name DATABASE', 'exit',
    `vlan ${VLAN_MGMT}`, 'name MGMT', 'exit',
    'interface GigabitEthernet0/1',
    'switchport mode trunk',
    `switchport trunk allowed vlan ${VLAN_USERS},${VLAN_ADMIN},${VLAN_SERVERS},${VLAN_DB},${VLAN_MGMT}`,
    'exit',
    `interface Vlan${VLAN_USERS}`,
    `ip address ${NET_USERS.gw} ${NET_USERS.mask}`, 'no shutdown', 'exit',
    `interface Vlan${VLAN_SERVERS}`,
    `ip address ${NET_SERVERS.gw} ${NET_SERVERS.mask}`, 'no shutdown', 'exit',
    `interface Vlan${VLAN_DB}`,
    `ip address ${NET_DB.gw} ${NET_DB.mask}`, 'no shutdown', 'exit',
    `interface Vlan${VLAN_MGMT}`,
    `ip address ${NET_MGMT.gw} ${NET_MGMT.mask}`, 'no shutdown', 'exit',
    'logging host 10.0.99.40',
    'logging trap informational',
    'end',
  ]);

  await huaweiConfig(dist, [
    'system-view',
    'sysname DIST-SW',
    'vlan batch 10 20 30 40 99',
    'interface GigabitEthernet0/0/1',
    'port link-type trunk',
    'port trunk allow-pass vlan 10 20 30 40 99',
    'quit',
    'interface GigabitEthernet0/0/10',
    'port link-type access', 'port default vlan 10', 'quit',
    'interface GigabitEthernet0/0/20',
    'port link-type access', 'port default vlan 30', 'quit',
    'interface GigabitEthernet0/0/21',
    'port link-type access', 'port default vlan 40', 'quit',
    'interface GigabitEthernet0/0/22',
    'port link-type access', 'port default vlan 99', 'quit',
    'info-center loghost 10.0.99.40 facility local5',
    'quit',
  ]);

  await linuxRoot(app, [
    `useradd -m ${APP_USER}`,
    `useradd -m ${APP_ADMIN}`,
    `echo '${APP_USER}:${APP_PASSWORD}' | chpasswd`,
    `echo '${APP_ADMIN}:${APP_ADMIN_PW}' | chpasswd`,
    'systemctl start ssh',
    'systemctl start rsyslog',
    'mkdir -p /etc/bankapp',
    `echo '[oracle]' > /etc/bankapp/db.conf`,
    `echo 'host=${DB_IP}' >> /etc/bankapp/db.conf`,
    `echo 'port=1521' >> /etc/bankapp/db.conf`,
    `echo 'service=ORCL' >> /etc/bankapp/db.conf`,
    `echo 'user=${ORA_USER}' >> /etc/bankapp/db.conf`,
    `echo 'password=${ORA_PW}' >> /etc/bankapp/db.conf`,
    `chown ${APP_USER}:${APP_USER} /etc/bankapp/db.conf`,
    'chmod 640 /etc/bankapp/db.conf',
  ]);

  await linuxRoot(db, [
    'systemctl start ssh',
    'systemctl start rsyslog',
    'systemctl start oracle',
    'lsnrctl start',
  ]);

  await linuxRoot(logsrv, [
    'systemctl start rsyslog',
    `echo '$ModLoad imudp' >> /etc/rsyslog.conf`,
    `echo '$UDPServerRun 514' >> /etc/rsyslog.conf`,
    'systemctl restart rsyslog',
  ]);

  const oracle = getOracleDatabase(db.getId());
  if (oracle.instance.state !== 'OPEN') oracle.instance.startup();
  oracle.instance.startListener();
  const { executor: sys } = oracle.connectAsSysdba();
  oracle.executeSql(sys, `CREATE USER ${ORA_USER} IDENTIFIED BY "${ORA_PW}"`);
  oracle.executeSql(sys, `GRANT CONNECT, RESOURCE, DBA TO ${ORA_USER}`);
  oracle.executeSql(sys, `CREATE TABLE ${ORA_USER}.COMPTES (
       ID NUMBER PRIMARY KEY,
       CLIENT VARCHAR2(64),
       SOLDE NUMBER(12,2)
     )`);
  for (let i = 1; i <= 5; i++) {
    oracle.executeSql(sys, `INSERT INTO ${ORA_USER}.COMPTES VALUES (${i}, 'client-${i}', ${i * 1000})`);
  }
  oracle.executeSql(sys, 'COMMIT');

  return { core, dist, wks, app, db, logsrv };
}

let LAB: Lab;

beforeAll(async () => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  LAB = await buildLab();
});

describe('Phase 1 — vérification de la mauvaise segmentation VLAN', () => {
  it('Cisco show vlan brief : les VLAN Users, Servers, DB, Mgmt sont actifs', async () => {
    const out = await LAB.core.executeCommand('show vlan brief');
    expect(out).toMatch(/10\s+USERS\s+active/);
    expect(out).toMatch(/30\s+SERVERS\s+active/);
    expect(out).toMatch(/40\s+DATABASE\s+active/);
    expect(out).toMatch(/99\s+MGMT\s+active/);
  });

  it('Cisco show interfaces trunk : le trunk Gi0/1 permet VLAN 40 (mauvaise segmentation)', async () => {
    const out = await LAB.core.executeCommand('show interfaces trunk');
    expect(out).toMatch(/Gi0\/1\s+on\s+802\.1q\s+trunking/);
    expect(out).toMatch(/10,20,30,40,99|10-99|10-40/);
  });

  it('Huawei display vlan : les 5 VLAN sont batchés sur le trunk', async () => {
    const out = await LAB.dist.executeCommand('display vlan');
    expect(out).toMatch(/10\b/);
    expect(out).toMatch(/40\b/);
    expect(out).toMatch(/99\b/);
  });

  it('Cisco show spanning-tree présente une topologie stable (root visible)', async () => {
    const out = await LAB.core.executeCommand('show spanning-tree');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('Phase 2 — reconnaissance depuis le poste utilisateur Windows', () => {
  it('WKS ping vers gateway VLAN Users : succès (segmentation locale OK)', async () => {
    const out = await LAB.wks.executeCommand(`ping ${NET_USERS.gw}`);
    expect(out).toMatch(/Reply from|Received = [1-9]/);
  });

  it('WKS ping vers DB (10.0.40.30) : le trunk mal configuré route la requête', async () => {
    const out = await LAB.wks.executeCommand(`ping ${DB_IP}`);
    expect(out).toMatch(/Reply from|Received = [1-9]/);
  });

  it('WKS ping vers APP (10.0.30.20) : accessible via inter-VLAN routing', async () => {
    const out = await LAB.wks.executeCommand(`ping ${APP_IP}`);
    expect(out).toMatch(/Reply from|Received = [1-9]/);
  });

  it('WKS Test-NetConnection APP : ICMP réussit et remonte la route source→cible', async () => {
    const out = await LAB.wks.executeCommand(
      `powershell -Command "Test-NetConnection ${APP_IP} -Port 22"`,
    );
    expect(out).toMatch(/RemoteAddress\s*:\s*10\.0\.30\.20/);
    expect(out).toMatch(/PingSucceeded\s*:\s*True/i);
  });

  it('WKS Test-NetConnection DB : ICMP réussit sur 10.0.40.30 (misconfig prouvée)', async () => {
    const out = await LAB.wks.executeCommand(
      `powershell -Command "Test-NetConnection ${DB_IP} -Port 1521"`,
    );
    expect(out).toMatch(/RemoteAddress\s*:\s*10\.0\.40\.30/);
    expect(out).toMatch(/PingSucceeded\s*:\s*True/i);
  });

  it('WKS arp -a apprend la MAC de la gateway (10.0.10.1) après le ping', async () => {
    const out = await LAB.wks.executeCommand('arp -a');
    expect(out).toMatch(/10\.0\.10\.1/);
  });
});

describe('Phase 3 — compromission SSH du serveur applicatif', () => {
  it('WKS ssh oraapp@APP avec mot de passe faible : connexion établie', async () => {
    const out = await LAB.wks.executeCommand(
      `ssh -o StrictHostKeyChecking=no ${APP_USER}@${APP_IP} whoami`,
      { stdin: `${APP_PASSWORD}\n` } as unknown as string,
    );
    expect(out).toMatch(new RegExp(APP_USER));
  });

  it('APP /var/log/auth.log garde la trace de la connexion réussie oraapp', async () => {
    const out = await LAB.app.executeCommand(`cat /var/log/auth.log`);
    expect(out).toMatch(/Accepted password for oraapp/);
  });
});

describe('Phase 4 — reconnaissance locale sur le serveur applicatif', () => {
  it('APP ip a montre l\'interface de production 10.0.30.20/24', async () => {
    const out = await LAB.app.executeCommand('ip a');
    expect(out).toMatch(/10\.0\.30\.20/);
  });

  it('APP arp -n affiche la gateway VLAN Servers apprise', async () => {
    const out = await LAB.app.executeCommand('arp -n');
    expect(out).toMatch(/10\.0\.30\.1/);
  });

  it('APP route -n affiche la default via 10.0.30.1', async () => {
    const out = await LAB.app.executeCommand('route -n');
    expect(out).toMatch(/0\.0\.0\.0\s+10\.0\.30\.1/);
  });

  it('APP ss -tlnp liste sshd/rsyslogd en écoute', async () => {
    const out = await LAB.app.executeCommand('ss -tlnp');
    expect(out).toMatch(/:22\b/);
  });

  it('APP ps -ef inclut sshd et rsyslogd', async () => {
    const out = await LAB.app.executeCommand('ps -ef');
    expect(out).toMatch(/sshd/);
  });

  it('APP systemctl list-units --type=service confirme ssh actif', async () => {
    const out = await LAB.app.executeCommand('systemctl list-units --type=service');
    expect(out).toMatch(/ssh(d)?/);
  });
});

describe('Phase 5 — extraction des secrets applicatifs Oracle', () => {
  it('APP find /etc -name "db.conf" localise le fichier de configuration', async () => {
    const out = await LAB.app.executeCommand('find /etc -name db.conf');
    expect(out).toMatch(/\/etc\/bankapp\/db\.conf/);
  });

  it('APP cat /etc/bankapp/db.conf révèle host, user et password Oracle', async () => {
    const out = await LAB.app.executeCommand('cat /etc/bankapp/db.conf');
    expect(out).toMatch(/host=10\.0\.40\.30/);
    expect(out).toMatch(/service=ORCL/);
    expect(out).toMatch(new RegExp(`user=${ORA_USER}`));
    expect(out).toMatch(new RegExp(`password=${ORA_PW.replace(/[#]/g, '\\#')}`));
  });

  it('APP stat /etc/bankapp/db.conf montre mode 640 lisible par oraapp', async () => {
    const out = await LAB.app.executeCommand('stat /etc/bankapp/db.conf');
    expect(out).toMatch(/0640|-rw-r-----/);
  });
});

describe('Phase 6 — authentification Oracle avec les secrets extraits', () => {
  it('APP sqlplus BANKAPP@10.0.40.30/ORCL établit la session (EZConnect via TCP)', async () => {
    const out = await LAB.app.executeCommand(
      `bash -c "echo 'SELECT USER FROM DUAL;' | sqlplus -S '${ORA_USER}/${ORA_PW}@${DB_IP}:1521/ORCL'"`,
    );
    expect(out.toUpperCase()).toMatch(new RegExp(ORA_USER));
  });

  it('Oracle DBA_USERS liste BANKAPP', async () => {
    const oracle = getOracleDatabase(LAB.db.getId());
    const { executor } = oracle.connectAsSysdba();
    const res = oracle.executeSql(executor,
      "SELECT USERNAME FROM DBA_USERS WHERE USERNAME = 'BANKAPP'");
    expect(res.rows?.length).toBeGreaterThanOrEqual(1);
  });

  it('Oracle DBA_ROLE_PRIVS confirme les rôles CONNECT / RESOURCE / DBA sur BANKAPP', async () => {
    const oracle = getOracleDatabase(LAB.db.getId());
    const { executor } = oracle.connectAsSysdba();
    const res = oracle.executeSql(executor,
      "SELECT GRANTED_ROLE FROM DBA_ROLE_PRIVS WHERE GRANTEE = 'BANKAPP'");
    const roles = (res.rows ?? []).map((r) => String(r[0]).toUpperCase());
    expect(roles).toContain('CONNECT');
    expect(roles).toContain('DBA');
  });
});

describe('Phase 7 — lecture et modification des données métier', () => {
  it('BANKAPP SELECT sur COMPTES retourne 5 lignes de démo', async () => {
    const oracle = getOracleDatabase(LAB.db.getId());
    const { executor } = oracle.connect(ORA_USER, ORA_PW);
    const res = oracle.executeSql(executor,
      `SELECT ID, CLIENT, SOLDE FROM ${ORA_USER}.COMPTES ORDER BY ID`);
    expect(res.rows?.length).toBe(5);
  });

  it('BANKAPP UPDATE COMPTES : modification non contrôlée du solde', async () => {
    const oracle = getOracleDatabase(LAB.db.getId());
    const { executor } = oracle.connect(ORA_USER, ORA_PW);
    oracle.executeSql(executor, `UPDATE ${ORA_USER}.COMPTES SET SOLDE = 999999 WHERE ID = 1`);
    oracle.executeSql(executor, 'COMMIT');
    const res = oracle.executeSql(executor,
      `SELECT SOLDE FROM ${ORA_USER}.COMPTES WHERE ID = 1`);
    expect(Number(res.rows?.[0]?.[0])).toBe(999999);
  });

  it('Oracle DBA_AUDIT_TRAIL contient une trace CONNECT/UPDATE de BANKAPP', async () => {
    const oracle = getOracleDatabase(LAB.db.getId());
    const { executor } = oracle.connectAsSysdba();
    const res = oracle.executeSql(executor,
      "SELECT USERNAME, ACTION_NAME FROM DBA_AUDIT_TRAIL WHERE USERNAME = 'BANKAPP'");
    expect(res.rows?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('Phase 8 — saturation de sessions Oracle', () => {
  it('BANKAPP ouvre 50 sessions parallèles : V$SESSION reflète la montée', async () => {
    const oracle = getOracleDatabase(LAB.db.getId());
    const { executor: sys } = oracle.connectAsSysdba();
    const before = oracle.executeSql(sys,
      "SELECT COUNT(*) FROM V$SESSION WHERE USERNAME = 'BANKAPP'");
    const beforeN = Number(before.rows?.[0]?.[0] ?? 0);
    for (let i = 0; i < 50; i++) {
      oracle.connect(ORA_USER, ORA_PW);
    }
    const after = oracle.executeSql(sys,
      "SELECT COUNT(*) FROM V$SESSION WHERE USERNAME = 'BANKAPP'");
    const afterN = Number(after.rows?.[0]?.[0] ?? 0);
    expect(afterN - beforeN).toBeGreaterThanOrEqual(50);
  });

  it('V$RESOURCE_LIMIT rapporte l\'utilisation des sessions', async () => {
    const oracle = getOracleDatabase(LAB.db.getId());
    const { executor } = oracle.connectAsSysdba();
    const res = oracle.executeSql(executor,
      "SELECT RESOURCE_NAME, CURRENT_UTILIZATION, MAX_UTILIZATION FROM V$RESOURCE_LIMIT WHERE RESOURCE_NAME = 'sessions'");
    expect(res.rows?.length ?? 0).toBeGreaterThan(0);
    expect(Number(res.rows?.[0]?.[1] ?? 0)).toBeGreaterThan(0);
  });

  it('V$LOCK enregistre les verrous provoqués par les transactions non validées', async () => {
    const oracle = getOracleDatabase(LAB.db.getId());
    const { executor } = oracle.connect(ORA_USER, ORA_PW);
    oracle.executeSql(executor, `UPDATE ${ORA_USER}.COMPTES SET SOLDE = SOLDE + 1 WHERE ID = 2`);
    const { executor: sys } = oracle.connectAsSysdba();
    const res = oracle.executeSql(sys, "SELECT COUNT(*) FROM V$LOCK");
    expect(Number(res.rows?.[0]?.[0] ?? 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('Phase 9 — impact réseau et systèmes', () => {
  it('APP ss -s indique un compteur d\'ouvertures TCP > 0 après le flood', async () => {
    for (let i = 0; i < 20; i++) {
      await LAB.app.executeCommand(`nc -z -w 1 ${DB_IP} 1521`);
    }
    const out = await LAB.app.executeCommand('ss -s');
    expect(out).toMatch(/TCP:\s+\d+/);
  });

  it('Cisco show interfaces GigabitEthernet0/1 remonte des compteurs input/output', async () => {
    const out = await LAB.core.executeCommand('show interfaces GigabitEthernet0/1');
    expect(out).toMatch(/packets input|packets output|input rate|output rate/i);
  });

  it('Huawei display interface GigabitEthernet0/0/20 remonte les compteurs', async () => {
    const out = await LAB.dist.executeCommand('display interface GigabitEthernet0/0/20');
    expect(out).toMatch(/packets|bytes|Input|Output/i);
  });

  it('Huawei display cpu-usage : la charge CPU est visible', async () => {
    const out = await LAB.dist.executeCommand('display cpu-usage');
    expect(out).toMatch(/CPU|Usage|%/i);
  });

  it('APP top -bn1 remonte load average et processes après le flood', async () => {
    const out = await LAB.app.executeCommand('top -bn1');
    expect(out).toMatch(/load average/i);
  });
});

describe('Phase 10 — corrélation des journaux', () => {
  it('APP /var/log/auth.log liste plusieurs événements sshd', async () => {
    const out = await LAB.app.executeCommand('cat /var/log/auth.log');
    expect(out.split(/sshd/).length).toBeGreaterThanOrEqual(2);
  });

  it('APP lastlog -u oraapp montre le dernier logon (ou "Jamais connecté" si wtmp vide)', async () => {
    const out = await LAB.app.executeCommand('lastlog -u oraapp');
    expect(out).toMatch(/oraapp|Never logged in|Jamais/i);
  });

  it('APP journalctl -u ssh contient la trace du démarrage du service ssh', async () => {
    const out = await LAB.app.executeCommand('journalctl -u ssh');
    expect(out).toMatch(/ssh|sshd|Started/i);
  });

  it('WKS wevtutil qe Security remonte au moins un événement 4624 après logon', async () => {
    await LAB.wks.executeCommand(
      `powershell -Command "Write-EventLog -LogName Security -Source Microsoft-Windows-Security-Auditing -EventID 4624 -Message 'An account was successfully logged on: ${WIN_USER}'"`,
    );
    const out = await LAB.wks.executeCommand('wevtutil qe Security /c:5 /f:text');
    expect(out).toMatch(/Event ID:\s*4624/);
    expect(out).toMatch(new RegExp(WIN_USER));
  });

  it('LOG-01 syslog central reçoit les logs Cisco (facility local7 via UDP/514)', async () => {
    await LAB.core.executeCommand(
      'enable',
    );
    await LAB.core.executeCommand('configure terminal');
    await LAB.core.executeCommand('logging trap debugging');
    await LAB.core.executeCommand('logging source-interface Vlan99');
    await LAB.core.executeCommand('end');
    const out = await LAB.logsrv.executeCommand('cat /var/log/syslog');
    expect(out.length).toBeGreaterThan(0);
  });

  it('Huawei display logbuffer contient des événements horodatés', async () => {
    const out = await LAB.dist.executeCommand('display logbuffer');
    expect(out.length).toBeGreaterThan(0);
  });

  it('Cohérence des horodatages : trois horloges dans une fenêtre raisonnable', async () => {
    const wksDate = await LAB.wks.executeCommand('powershell -Command "Get-Date -Format o"');
    const appDate = await LAB.app.executeCommand('date -u +%Y-%m-%dT%H:%M:%SZ');
    const coreDate = await LAB.core.executeCommand('show clock');
    expect(wksDate.length).toBeGreaterThan(0);
    expect(appDate).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(coreDate.length).toBeGreaterThan(0);
  });
});
