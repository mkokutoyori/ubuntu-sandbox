/**
 * La persistance d'une topologie ne doit garder QUE ce qui a change depuis l'instanciation des
 * equipements, pas ce que la fabrique provisionne a chaque creation. Le point de comparaison de
 * l'export etait un systeme de fichiers NU (`new VirtualFileSystem()`), pas une machine neuve : toute
 * l'image (binaires, unites systemd, modules, /etc, journaux de demarrage) etait donc ecrite.
 *
 * MESURE (une machine neuve, rien touche, `exportTopology`) : `linux-pc` 144 947 octets (134 641 de
 * fichiers, 2 459 d'unites systemd), `linux-server` 152 847, `windows-pc` 10 927 (journaux .evtx, compte
 * `User`), `firewall-fortinet` 14 388 (certificat et cle generes a chaque instance). Les seuls points de
 * comparaison honnetes sont le JUMEAU d'usine du meme equipement (`withFactoryTwin`) : la meme machine
 * telle que `createDevice` la construit, jetee apres comparaison sans toucher au registre, au compteur
 * de MAC ni au journal. Les journaux d'execution (`/var/log`, `.evtx`) et les horodatages de compte
 * sont de l'etat d'execution, pas de la configuration : ils ne sont plus ecrits.
 *
 * Apres correction : `linux-pc` 471 octets, `windows-pc` 372, `firewall-fortinet` 693. Ce qui a change
 * est ecrit — fichier cree ou edite, fichier SUPPRIME (`removedPaths`, avant on ne savait pas ecrire
 * une suppression), unite systemd modifiee, compte cree ou supprime — et revient a l'importation.
 *
 * Oracle et Windows Server (meme principe, deuxieme temps). MESURE : un `linux-server` dont la base n'a
 * pas ete touchee ecrivait 305 327 octets (24 tables de demonstration et 6 comptes, que `installAllDemoSchemas`
 * recree a chaque boot), puis 63 Ko de fichiers d'image Oracle ; apres comparaison a une base d'usine il
 * reste 0. A l'inverse, un Windows Server dont on avait installe DNS, DHCP et IIS puis cree une zone et une
 * etendue ne gardait AUCUN role : a la reouverture `Get-DnsServerResourceRecord` repondait « not recognized »
 * (le role n'etait plus installe), et ni la zone ni l'etendue ne revenaient. Les fonctionnalites installees
 * (`RoleManager`), les zones DNS (par le fichier de zone que le role ecrit deja) et les etendues DHCP sont
 * maintenant ecrites ; ce que l'installation d'un role provisionne (service, site par defaut, entrees de
 * registre) ne l'est plus, le jumeau d'usine recevant les memes fonctionnalites avant comparaison. Les trois
 * lignes de base locales du registre, des services et du pare-feu Windows sont fermees sur ce jumeau.
 *
 * Oracle, troisieme temps. MESURE : apres reouverture, une vue (`ORA-00942`), une sequence (`ORA-02289`), un index,
 * un tablespace, un role, `ALTER SYSTEM SET open_cursors=500` (restait 300) et `ALTER USER scott ACCOUNT LOCK`
 * (restait OPEN) etaient perdus : seuls comptes et tables voyageaient. Le DDL de `DBMS_METADATA` n'etait pas
 * rejouable (`FORCE EDITIONABLE`, `MINVALUE` avant `START`, noms entre guillemets, `PACKAGE BODY`, parametres et
 * type de retour des fonctions, `START WITH` decale d'un pas, `CREATE SEQUENCE` sans `MINVALUE`/`MAXVALUE`,
 * `WITH READ ONLY` ignore) : l'analyseur et l'extracteur sont corriges, puis les objets rejoues par ce DDL.
 *
 * Discriminee contre l'etat d'avant (`git stash` des sources) : 16 des 18 cas du premier temps tombent, 4 des 4
 * cas Oracle / Windows Server du second, et les 5 cas du troisieme (objets, DDL rejouable, securite, tablespace
 * et parametres) pour la partie qui existait avant ce lot. Les 2 qui passent des deux cotes sont NOMMES : le temoin
 * « une machine neuve exportee puis rouverte garde son image » (il prouve que ne pas ecrire l'image ne la
 * perd pas) et « un fichier au format complet d'avant s'ouvre encore » (non-regression : l'importation
 * applique un fichier complet comme un fichier delta).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, Logger, MACAddress, IPAddress, SubnetMask, type Equipment } from '@/network';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { EventBus } from '@/events/EventBus';
import { installAllDemoSchemas } from '@/database/oracle/demo/DemoSchemas';
import { captureOracleDelta, restoreOracleDelta } from '@/database/oracle/persistence/OracleStateDelta';
import { MetadataExtractor } from '@/database/oracle/metadata/MetadataExtractor';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const asMap = (devices: Equipment[]) => new Map(devices.map((d) => [d.getId(), d]));
const exportOf = (devices: Equipment[]) => exportTopology('lab', asMap(devices), []);

async function roundTrip(devices: Equipment[]) {
  const json = JSON.parse(JSON.stringify(exportOf(devices)));
  const reopened = await importTopology(json);
  const byName = (name: string) => [...reopened.deviceInstances.values()].find((d) => d.getName() === name)!;
  return { json, byName };
}

const IDENTITY_KEYS = ['id', 'type', 'name', 'x', 'y', 'isPoweredOn', 'interfaces'];
const FRESH_TYPES = [
  'linux-pc', 'linux-server', 'windows-pc', 'windows-server', 'switch-cisco', 'switch-huawei',
  'switch-generic', 'router-cisco', 'router-huawei', 'firewall-cisco', 'firewall-fortinet',
] as const;

describe('a machine nobody touched writes nothing it was provisioned with', () => {
  for (const type of FRESH_TYPES) {
    it(`${type}: only its identity and its interfaces`, () => {
      const device = createDevice(type, 10, 20);
      const [entry] = exportOf([device]).devices;
      expect(Object.keys(entry).filter((key) => !IDENTITY_KEYS.includes(key))).toEqual([]);
      expect(JSON.stringify(entry).length).toBeLessThan(2_500);
    });
  }

  it('witness: a fresh machine exported then reopened still has its whole image', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const { byName } = await roundTrip([pc]);
    const reopened = byName('PC1') as LinuxPC;
    expect(await reopened.executeCommand('ls /usr/bin/sudo')).toContain('/usr/bin/sudo');
    expect(await reopened.executeCommand('systemctl is-enabled cron')).toContain('enabled');
    expect(await reopened.executeCommand('cat /etc/hostname')).toContain('PC1');
  });
});

describe('exporting leaves no trace on the lab', () => {
  it('registers no device, moves no MAC, writes no log line, reserves no name', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const win = new WindowsPC('windows-pc', 'W1');
    const registered = EquipmentRegistry.getInstance().getAll().length;
    const logs = Logger.getLogs().length;
    const nextMacBefore = MACAddress.preservingCounter(() => MACAddress.generate().toString());
    exportOf([pc, win]);
    expect(EquipmentRegistry.getInstance().getAll().length).toBe(registered);
    expect(Logger.getLogs().length).toBe(logs);
    expect(MACAddress.preservingCounter(() => MACAddress.generate().toString())).toBe(nextMacBefore);
  });
});

describe('what changed is written, and comes back', () => {
  it('Linux: a created file, an edited file, a deleted file and a changed service', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sudo mkdir -p /srv/lab');
    await pc.executeCommand("sudo sh -c 'echo hello > /srv/lab/note.txt'");
    await pc.executeCommand("sudo sh -c 'echo custom banner > /etc/issue'");
    await pc.executeCommand('sudo rm /etc/skel/.profile');
    await pc.executeCommand('sudo systemctl disable cron');

    const { json, byName } = await roundTrip([pc]);
    const entry = json.devices[0];
    expect((entry.files as { path: string }[]).map((f) => f.path).sort()).toEqual(['/etc/issue', '/srv/lab/note.txt']);
    expect(entry.removedPaths).toEqual(['/etc/skel/.profile', '/etc/systemd/system/multi-user.target.wants/cron.service']);
    expect((entry.linuxServices as { name: string }[]).map((s) => s.name)).toEqual(['cron']);

    const reopened = byName('PC1') as LinuxPC;
    expect(await reopened.executeCommand('cat /srv/lab/note.txt')).toContain('hello');
    expect(await reopened.executeCommand('cat /etc/issue')).toContain('custom banner');
    expect(await reopened.executeCommand('ls /etc/skel/.profile')).toContain('No such file');
    expect(await reopened.executeCommand('ls /etc/skel/.bashrc')).toContain('.bashrc');
    expect(await reopened.executeCommand('systemctl is-enabled cron')).toContain('disabled');
    expect(await reopened.executeCommand('systemctl is-enabled ssh')).toContain('enabled');
  });

  it('Windows: a created file, a deleted file and a created account', async () => {
    const win = new WindowsPC('windows-pc', 'W1');
    win.setCurrentUser('Administrator');
    win.getFileSystem().mkdirp('C:\\lab');
    win.getFileSystem().createFile('C:\\lab\\note.txt', 'hello');
    win.getFileSystem().deleteFile('C:\\Windows\\win.ini');
    await win.executeCommand('net user labuser Passw0rd!123 /add');

    const { json, byName } = await roundTrip([win]);
    const entry = json.devices[0];
    expect((entry.files as { path: string }[]).map((f) => f.path)).toEqual(['C:\\lab\\note.txt']);
    expect(entry.removedPaths).toEqual(['C:\\Windows\\win.ini']);
    expect(entry.windowsAccounts?.users.map((u) => u.name)).toEqual(['labuser']);

    const reopened = byName('W1') as WindowsPC;
    expect(reopened.getFileSystem().readFile('C:\\lab\\note.txt').content).toBe('hello');
    expect(reopened.getFileSystem().exists('C:\\Windows\\win.ini')).toBe(false);
    expect(reopened.getUserManager().getUser('labuser')).toBeDefined();
    expect(reopened.getUserManager().getUser('Administrator')).toBeDefined();
  });

  it('a router writes its configuration only once it differs from the factory one', async () => {
    const router = new CiscoRouter('R1');
    expect(exportOf([router]).devices[0].runningConfigText).toBeUndefined();
    router.configureInterface('GigabitEthernet0/0', new IPAddress('10.1.1.1'), new SubnetMask('255.255.255.0'));
    const { json, byName } = await roundTrip([router]);
    expect(json.devices[0].runningConfigText).toContain('10.1.1.1');
    const reopened = byName('R1') as CiscoRouter;
    expect(reopened.getPort('GigabitEthernet0/0')!.getIPAddress()!.toString()).toBe('10.1.1.1');
  });

  it('the hostname is written only when it is not the name', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(exportOf([pc]).devices[0].hostname).toBeUndefined();
    pc.setHostname('web01');
    const { json, byName } = await roundTrip([pc]);
    expect(json.devices[0].hostname).toBe('web01');
    expect(byName('PC1').getHostname()).toBe('web01');
  });

  it('a file written in the old full format still opens', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const json = JSON.parse(JSON.stringify(exportOf([pc])));
    json.devices[0].hostname = 'PC1';
    json.devices[0].files = [{ path: '/srv/old.txt', content: 'legacy', uid: 0, gid: 0, mode: 0o644 }];
    const reopened = await importTopology(json);
    const device = [...reopened.deviceInstances.values()][0] as LinuxPC;
    expect(await device.executeCommand('cat /srv/old.txt')).toContain('legacy');
    expect(await device.executeCommand('ls /usr/bin/sudo')).toContain('/usr/bin/sudo');
  });
});

describe('Oracle writes only the accounts and tables that differ from a fresh database', () => {
  beforeEach(() => { resetAllOracleInstances(); });

  it('an untouched database writes nothing', () => {
    const server = new LinuxServer('linux-server', 'S1');
    getOracleDatabase(server.getId());
    const [entry] = exportOf([server]).devices;
    expect(entry.oracle).toBeUndefined();
    expect(JSON.stringify(entry).length).toBeLessThan(2_500);
  });

  it('a changed row, a new table, a new account and a dropped table are written, and come back', async () => {
    const server = new LinuxServer('linux-server', 'S1');
    const db = getOracleDatabase(server.getId());
    const sys = db.connectAsSysdba().executor;
    const run = (sql: string) => db.executeSql(sys, sql);
    run("UPDATE scott.emp SET sal = 9999 WHERE ename = 'KING'");
    run('CREATE TABLE scott.lab_notes (id NUMBER, note VARCHAR2(40))');
    run("INSERT INTO scott.lab_notes VALUES (1, 'kept')");
    run('CREATE USER labuser IDENTIFIED BY lab123');
    run('DROP TABLE scott.bonus');

    const { json } = await roundTrip([server]);
    const state = json.devices[0].oracle as { users: { record: { username: string } }[]; dump: { tables: { name: string }[] }; droppedTables?: { name: string }[] };
    expect(state.users.map((u) => u.record.username)).toEqual(['LABUSER']);
    expect(state.dump.tables.map((t) => t.name).sort()).toEqual(['EMP', 'LAB_NOTES']);
    expect(state.droppedTables?.map((t) => t.name)).toEqual(['BONUS']);

    const reopened = [...(await importTopology(JSON.parse(JSON.stringify(json)))).deviceInstances.values()][0];
    const back = getOracleDatabase(reopened.getId());
    const s2 = back.connectAsSysdba().executor;
    expect(JSON.stringify(back.executeSql(s2, "SELECT sal FROM scott.emp WHERE ename = 'KING'"))).toContain('9999');
    expect(JSON.stringify(back.executeSql(s2, 'SELECT note FROM scott.lab_notes'))).toContain('kept');
    expect(back.catalog.userExists('LABUSER')).toBe(true);
    expect(back.storage.tableExists('SCOTT', 'BONUS')).toBe(false);
    expect(back.storage.tableExists('HR', 'EMPLOYEES')).toBe(true);
  });
});

describe('Windows Server writes its installed roles and what was configured in them', () => {
  const shellOf = (server: WindowsServer) => {
    server.setCurrentUser('Administrator');
    const shell = PowerShellSubShell.create(server).subShell;
    return async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  };

  async function configuredServer() {
    const server = new WindowsServer('WS1');
    const ps = shellOf(server);
    await ps('Install-WindowsFeature DNS -IncludeManagementTools');
    await ps('Install-WindowsFeature DHCP');
    await ps('Install-WindowsFeature Web-Server');
    await ps('Add-DnsServerPrimaryZone -Name lab.local -ZoneFile lab.local.dns');
    await ps('Add-DnsServerResourceRecordA -Name www -ZoneName lab.local -IPv4Address 10.0.0.5');
    await ps('Add-DhcpServerv4Scope -Name Lab -StartRange 10.0.0.100 -EndRange 10.0.0.200 -SubnetMask 255.255.255.0');
    await ps('Add-DhcpServerv4Reservation -ScopeId 10.0.0.0 -IPAddress 10.0.0.150 -ClientId 00-11-22-33-44-55');
    await ps('Add-DhcpServerv4ExclusionRange -ScopeId 10.0.0.0 -StartRange 10.0.0.120 -EndRange 10.0.0.130');
    return server;
  }

  it('what installing a role provisions is not written twice: features, roles and the zone file only', async () => {
    const server = await configuredServer();
    const [entry] = exportOf([server]).devices;
    expect(Object.keys(entry).filter((key) => !IDENTITY_KEYS.includes(key)).sort())
      .toEqual(['files', 'windowsFeatures', 'windowsRoles']);
    expect((entry.files as { path: string }[]).map((f) => f.path)).toEqual(['C:\\Windows\\System32\\dns\\lab.local.dns']);
    expect(entry.windowsFeatures?.installed).toEqual(['DNS', 'DHCP', 'Web-Server']);
    expect(JSON.stringify(entry).length).toBeLessThan(3_000);
  });

  it('the roles, the zone with its record and the DHCP scope come back after reopening', async () => {
    const server = await configuredServer();
    const { byName } = await roundTrip([server]);
    const reopened = byName('WS1') as WindowsServer;
    const ps = shellOf(reopened);
    expect(await ps('Get-WindowsFeature | Where-Object Installed | Select-Object -ExpandProperty Name')).toContain('Web-Server');
    expect(await ps('Get-DnsServerResourceRecord -ZoneName lab.local -Name www')).toContain('10.0.0.5');
    expect(await ps('Get-DhcpServerv4Scope')).toContain('10.0.0.100');
    expect(await ps('Get-DhcpServerv4Reservation -ScopeId 10.0.0.0')).toContain('10.0.0.150');
    expect(await ps('Get-DhcpServerv4ExclusionRange -ScopeId 10.0.0.0')).toContain('10.0.0.120');
  });
});

describe('Oracle writes the schema objects that differ from a fresh database, and they come back', () => {
  beforeEach(() => { resetAllOracleInstances(); });

  const DDL = [
    'CREATE VIEW scott.v_rich AS SELECT ename, sal FROM scott.emp WHERE sal > 2000',
    'CREATE SEQUENCE scott.seq_lab START WITH 100 INCREMENT BY 5 MINVALUE 10 MAXVALUE 5000 NOCYCLE',
    'CREATE INDEX scott.ix_lab ON scott.emp (ename)',
    'CREATE UNIQUE INDEX scott.ux_lab ON scott.dept (dname)',
    'CREATE SYNONYM scott.syn_emp FOR scott.emp',
    'CREATE PUBLIC SYNONYM pub_dept FOR scott.dept',
    'CREATE OR REPLACE FUNCTION scott.f_plus (x IN NUMBER, y IN NUMBER) RETURN NUMBER AS BEGIN RETURN x + y; END',
    'CREATE OR REPLACE PACKAGE scott.pkg_lab AS FUNCTION g RETURN NUMBER; END pkg_lab',
    'CREATE OR REPLACE PACKAGE BODY scott.pkg_lab AS FUNCTION g RETURN NUMBER IS BEGIN RETURN 7; END; END pkg_lab',
    'CREATE OR REPLACE TRIGGER scott.t_lab BEFORE INSERT ON scott.dept FOR EACH ROW BEGIN NULL; END',
  ];

  async function labServer() {
    const server = new LinuxServer('linux-server', 'S1');
    const db = getOracleDatabase(server.getId());
    const sys = db.connectAsSysdba().executor;
    for (const statement of DDL) db.executeSql(sys, statement);
    db.executeSql(sys, 'SELECT scott.seq_lab.NEXTVAL FROM dual');
    db.executeSql(sys, 'SELECT scott.seq_lab.NEXTVAL FROM dual');
    db.executeSql(sys, 'DROP INDEX scott.ix_lab');
    db.executeSql(sys, 'CREATE INDEX scott.ix_lab ON scott.emp (job)');
    return { server, db, sys };
  }

  it('each object is written once, in the form a DBA would script it', async () => {
    const { server } = await labServer();
    const state = exportOf([server]).devices[0].oracle as { objects: { kind: string; name: string }[] };
    expect(state.objects.map((o) => `${o.kind}:${o.name}`).sort()).toEqual([
      'FUNCTION:F_PLUS', 'INDEX:IX_LAB', 'INDEX:UX_LAB', 'PACKAGE:PKG_LAB', 'PACKAGE_BODY:PKG_LAB',
      'SEQUENCE:SEQ_LAB', 'SYNONYM:PUB_DEPT', 'SYNONYM:SYN_EMP', 'TRIGGER:T_LAB', 'VIEW:V_RICH',
    ]);
  });

  it('after reopening, every object works as it did and the sequence goes on where it stopped', async () => {
    const { server } = await labServer();
    const { byName } = await roundTrip([server]);
    const db = getOracleDatabase(byName('S1').getId());
    const sys = db.connectAsSysdba().executor;
    const cell = (sql: string) => JSON.stringify((db.executeSql(sys, sql) as { rows: unknown[][] }).rows);
    expect(cell('SELECT COUNT(*) FROM scott.v_rich')).toBe(cell('SELECT COUNT(*) FROM scott.emp WHERE sal > 2000'));
    expect(cell('SELECT scott.seq_lab.NEXTVAL FROM dual')).toBe('[[110]]');
    expect(cell("SELECT index_name FROM all_indexes WHERE owner = 'SCOTT' AND index_name IN ('IX_LAB', 'UX_LAB') ORDER BY 1"))
      .toBe('[["IX_LAB"],["UX_LAB"]]');
    expect(db.storage.getAllSynonyms().map((x) => `${x.owner}.${x.name}->${x.tableOwner}.${x.tableName}`).sort())
      .toEqual(['PUBLIC.PUB_DEPT->SCOTT.DEPT', 'SCOTT.SYN_EMP->SCOTT.EMP']);
    expect(cell('SELECT scott.f_plus(2, 3) FROM dual')).toBe('[[5]]');
    expect(db.catalog.getStoredUnits().filter((u) => u.name === 'PKG_LAB').map((u) => u.type).sort())
      .toEqual(['PACKAGE', 'PACKAGE BODY']);
    expect(db.catalog.getStoredUnits().find((u) => u.type === 'PACKAGE BODY')?.body).toContain('RETURN 7');
    expect(db.storage.getAllTriggers().some((t) => t.name === 'T_LAB')).toBe(true);
    expect(db.storage.getIndexes('SCOTT').find((i) => i.name === 'IX_LAB')?.columns).toEqual(['JOB']);
  });

  it('a dropped factory object stays dropped', async () => {
    const server = new LinuxServer('linux-server', 'S1');
    const db = getOracleDatabase(server.getId());
    const sys = db.connectAsSysdba().executor;
    const factoryIndex = db.storage.getIndexes('SCOTT')[0].name;
    db.executeSql(sys, `DROP INDEX scott.${factoryIndex}`);
    const { byName } = await roundTrip([server]);
    const back = getOracleDatabase(byName('S1').getId());
    expect(back.storage.getIndexes('SCOTT').map((i) => i.name)).not.toContain(factoryIndex);
  });
});

describe('what Oracle writes is enough to rebuild each object exactly', () => {
  const factoryDatabase = () => {
    const database = new OracleDatabase();
    database.instance.setEventBus(new EventBus());
    database.instance.startup();
    installAllDemoSchemas(database);
    return database;
  };

  it('every object restored onto a fresh database scripts back to the same DDL', () => {
    const source = factoryDatabase();
    const sys = source.connectAsSysdba().executor;
    for (const statement of [
      'CREATE VIEW scott.v1 (n, s) AS SELECT ename, sal FROM scott.emp WITH READ ONLY',
      'CREATE VIEW scott.v2 AS SELECT * FROM scott.emp WHERE sal > 100 WITH CHECK OPTION',
      'CREATE SEQUENCE scott.s1 START WITH 7 INCREMENT BY 3 MINVALUE 1 MAXVALUE 900 CYCLE CACHE 5',
      'CREATE SEQUENCE scott.s2 NOCACHE',
      'CREATE INDEX scott.i1 ON scott.emp (UPPER(ename))',
      'CREATE BITMAP INDEX scott.i2 ON scott.emp (job)',
      'CREATE INDEX scott.i3 ON scott.emp (deptno, job)',
      'CREATE OR REPLACE TRIGGER scott.tw AFTER UPDATE ON scott.emp FOR EACH ROW WHEN (NEW.sal > 100) BEGIN NULL; END',
      'CREATE OR REPLACE PROCEDURE scott.pp (a IN NUMBER, b OUT VARCHAR2) AS BEGIN b := TO_CHAR(a); END',
    ]) source.executeSql(sys, statement);

    const delta = captureOracleDelta(source, factoryDatabase())!;
    const target = factoryDatabase();
    restoreOracleDelta(target, JSON.parse(JSON.stringify(delta)));

    const before = new MetadataExtractor(source.storage, source.catalog);
    const after = new MetadataExtractor(target.storage, target.catalog);
    const mismatched = (delta.objects ?? [])
      .filter((o) => before.getDdl(o.kind, o.name, o.owner) !== after.getDdl(o.kind, o.name, o.owner))
      .map((o) => `${o.kind}:${o.name}`);
    expect(delta.objects?.length).toBe(9);
    expect(mismatched).toEqual([]);
  });

  it('the DDL Oracle scripts is DDL Oracle accepts: quoted names, FORCE EDITIONABLE views, MINVALUE before START', () => {
    const database = factoryDatabase();
    const sys = database.connectAsSysdba().executor;
    database.executeSql(sys, 'CREATE OR REPLACE FORCE EDITIONABLE VIEW "SCOTT"."VQ" AS SELECT ename FROM scott.emp');
    database.executeSql(sys, 'CREATE SEQUENCE "SCOTT"."SQ" MINVALUE 5 MAXVALUE 50 INCREMENT BY 5 START WITH 10 CACHE 20 NOORDER NOCYCLE');
    database.executeSql(sys, 'CREATE OR REPLACE SYNONYM "SCOTT"."SQN" FOR "SCOTT"."EMP"');
    expect(database.storage.getViewMeta('SCOTT', 'VQ')).toBeDefined();
    expect(database.storage.getSequence('SCOTT', 'SQ')?.minValue).toBe(5);
    expect(database.storage.getSequence('SCOTT', 'SQ')?.maxValue).toBe(50);
    expect(database.storage.getSynonym('SCOTT', 'SQN')?.tableName).toBe('EMP');
  });
});

describe('Oracle writes the security, tablespace and parameter changes, and they come back', () => {
  beforeEach(() => { resetAllOracleInstances(); });

  async function reopenedAfter(changes: string[]) {
    const server = new LinuxServer('linux-server', 'S1');
    const db = getOracleDatabase(server.getId());
    const sys = db.connectAsSysdba().executor;
    for (const statement of changes) db.executeSql(sys, statement);
    const { json, byName } = await roundTrip([server]);
    const back = getOracleDatabase(byName('S1').getId());
    return { json, back, db };
  }

  it('an altered account keeps its state, its profile, and the grants and roles around it', async () => {
    const { json, back } = await reopenedAfter([
      'CREATE PROFILE lab_prof LIMIT FAILED_LOGIN_ATTEMPTS 3',
      'CREATE ROLE labrole',
      'GRANT CREATE TABLE TO labrole',
      'GRANT labrole TO scott',
      'GRANT SELECT ON hr.employees TO scott',
      'ALTER USER scott PROFILE lab_prof',
      'ALTER USER scott ACCOUNT LOCK',
    ]);
    const state = json.devices[0].oracle as { users: { record: { username: string } }[] };
    expect(state.users.map((u) => u.record.username)).toEqual(['SCOTT']);
    expect(back.catalog.getUser('SCOTT')?.accountStatus).toBe('LOCKED');
    expect(back.catalog.getUser('SCOTT')?.profile).toBe('LAB_PROF');
    expect(back.catalog.getProfiles().get('LAB_PROF')?.get('FAILED_LOGIN_ATTEMPTS')).toBe('3');
    expect(back.catalog.roleExists('LABROLE')).toBe(true);
    expect(back.catalog.getRoleGrants().some((g) => g.grantee === 'SCOTT' && g.role === 'LABROLE')).toBe(true);
    expect(back.catalog.hasTablePrivilege('SCOTT', 'SELECT', 'HR', 'EMPLOYEES')).toBe(true);
    expect(back.catalog.hasSystemPrivilege('SCOTT', 'CREATE TABLE')).toBe(true);
  });

  it('a revoked factory grant stays revoked, and a dropped role stays dropped', async () => {
    const server = new LinuxServer('linux-server', 'S1');
    const probe = getOracleDatabase(server.getId());
    const factoryGrant = probe.catalog.getRoleGrants().find((g) => g.grantee === 'SCOTT')!;
    probe.executeSql(probe.connectAsSysdba().executor, `REVOKE ${factoryGrant.role} FROM scott`);
    const { byName } = await roundTrip([server]);
    const back = getOracleDatabase(byName('S1').getId());
    expect(back.catalog.getRoleGrants().some((g) => g.grantee === 'SCOTT' && g.role === factoryGrant.role)).toBe(false);
  });

  it('a tablespace and a system parameter survive, the parameter in memory and in the spfile', async () => {
    const { json, back } = await reopenedAfter([
      "CREATE TABLESPACE lab DATAFILE '/u01/app/oracle/oradata/ORCL/lab01.dbf' SIZE 10M",
      'ALTER SYSTEM SET open_cursors = 500',
    ]);
    const state = json.devices[0].oracle as { tablespaces: { name: string }[]; parameters: { memory: Record<string, string> } };
    expect(state.tablespaces.map((t) => t.name)).toEqual(['LAB']);
    expect(state.parameters.memory.open_cursors).toBe('500');
    expect(back.storage.getTablespace('LAB')?.datafiles[0].path).toContain('lab01.dbf');
    expect(back.instance.getParameter('open_cursors')).toBe('500');
    expect(back.instance.getSpfileParameters().get('open_cursors')).toBe('500');
  });
});
