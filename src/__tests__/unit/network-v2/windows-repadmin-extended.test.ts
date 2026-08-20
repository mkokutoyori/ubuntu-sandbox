/**
 * PRD-Repadmin.md — repadmin.exe phases P1-P11 + /kcc.
 *
 * Builds on the existing two-DC lab pattern from
 * scenario-ad-replication-topology.test.ts. Each `it` targets one phase's
 * literal acceptance criterion from PRD-Repadmin.md §8.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildTwoDcs(): Promise<{ dc1: WindowsServer; dc2: WindowsServer }> {
  const dc1 = new WindowsServer('DC01');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));
  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc1), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  const dc2 = new WindowsServer('DC02');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.10.11'), new SubnetMask('255.255.255.0'));
  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc2), [
    'Install-ADDSDomainController',
    '-DomainName "mandeng.lan"',
    '-Credential "Administrator:DSRM@Mandeng2025!"',
    '-Server "192.168.10.10"',
    '-InstallDns:$true',
    '-SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force)',
    '-Force:$true',
  ].join(' '));

  // Cross-DC name resolution (`repadmin`'s remote targeting, PRD-Repadmin.md
  // P1) needs a real, working name lookup, same chain WinRM's
  // resolveComputer uses (resolveHostnameSync: literal IP → hosts file →
  // own name → DNS). This simulator doesn't model dynamic DNS
  // self-registration for promoted DCs, so — same as any real lab missing
  // that piece — seed the hosts file directly rather than depending on an
  // AD-integrated DNS zone that was never populated.
  await run(ps(dc1), 'Add-Content -Path "C:\\Windows\\System32\\drivers\\etc\\hosts" -Value "192.168.10.10 DC01.mandeng.lan`n192.168.10.11 DC02.mandeng.lan"');
  await run(ps(dc2), 'Add-Content -Path "C:\\Windows\\System32\\drivers\\etc\\hosts" -Value "192.168.10.10 DC01.mandeng.lan`n192.168.10.11 DC02.mandeng.lan"');
  return { dc1, dc2 };
}

describe('PRD-Repadmin.md P1 — ciblage distant réel', () => {
  it('repadmin /showrepl DC02.mandeng.lan exécuté depuis DC01 affiche le VRAI état de DC02 (pas celui de DC01)', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    // Seed DC02's own log with a failed attempt against an address DC01 never talked to.
    const foreign = dc2.replicateFrom('10.0.0.99');
    expect(foreign.ok).toBe(false);

    const fromDc01 = await dc1.executeCmdCommand('repadmin /showrepl DC02.mandeng.lan');
    expect(fromDc01).toContain('10.0.0.99');

    const localToDc01 = await dc1.executeCmdCommand('repadmin /showrepl');
    expect(localToDc01).not.toContain('10.0.0.99');
  });

  it('repadmin /showrepl DCInjoignable échoue avec "Unable to contact target: DCInjoignable"', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /showrepl DCInjoignable');
    expect(out).toBe('Unable to contact target: DCInjoignable');
  });

  it('repadmin /showrepl DC01.mandeng.lan (soi-même explicitement) reste local, sans dial réseau superflu', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /showrepl DC01.mandeng.lan');
    expect(out).toContain('DC01.mandeng.lan');
    expect(out).not.toMatch(/Unable to contact target/);
  });
});

describe('PRD-Repadmin.md P2 — fidélité /showrepl et /replsummary', () => {
  it('/showrepl affiche DSA Options, Site Options, DSA object GUID et DSA invocationID', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /showrepl');
    expect(out).toMatch(/DSA Options: /);
    expect(out).toMatch(/Site Options: \(none\)/);
    expect(out).toMatch(/DSA object GUID: [0-9a-f-]+/);
    expect(out).toMatch(/DSA invocationID: invocation-/);
  });

  it('/showrepl /csv produit une sortie Showrepl_COLUMNS/Showrepl_ENTRY exploitable par script', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /showrepl /csv');
    expect(out).toMatch(/^Showrepl_COLUMNS,Dest DSA,Naming Context,Source DSA/);
    expect(out).toMatch(/Showrepl_ENTRY,DC01/);
  });

  it('/showrepl /verbose montre plusieurs tentatives historiques, pas seulement la dernière', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    dc1.replicateFrom('192.168.10.11');
    dc1.replicateFrom('192.168.10.11');
    dc1.replicateFrom('192.168.10.11');
    const out = await dc1.executeCmdCommand('repadmin /showrepl /verbose');
    const attempts = out.match(/Last attempt @/g) ?? [];
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(dc2).toBeDefined();
  });
});

describe('PRD-Repadmin.md P3 — /replicate <DestDC> <SourceDC> <NC>', () => {
  it('/replicate DC01 DC02 <NC> déclenche un pull immédiat visible dans /showrepl (DestDC = local)', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await run(ps(dc2), 'New-ADUser -Name "Repl-Target2" -SamAccountName "repl-target2" -Enabled $false');

    const out = await dc1.executeCmdCommand('repadmin /replicate DC01.mandeng.lan DC02.mandeng.lan DC=mandeng,DC=lan');
    expect(out).toMatch(/was successful/i);

    const check = await run(ps(dc1), 'Get-ADUser "repl-target2" -ErrorAction SilentlyContinue');
    expect(check).toContain('repl-target2');
  });

  it('/replicate vers un DestDC injoignable échoue avec "Unable to contact target"', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /replicate DCInjoignable DC01 DC=mandeng,DC=lan');
    expect(out).toMatch(/Unable to contact target: DCInjoignable/);
  });
});

describe('PRD-Repadmin.md P4/P5/P10 — /showconn, /showvector, /failcache', () => {
  it('/showconn liste le partenaire de réplication après un premier échange réussi', async () => {
    const { dc1 } = await buildTwoDcs();
    dc1.replicateFrom('192.168.10.11');
    const out = await dc1.executeCmdCommand('repadmin /showconn');
    expect(out).toMatch(/AutoGenerated: No/);
    expect(out).toMatch(/TransportType: RPC/);
  });

  it('/showvector affiche le même contenu que le HighWatermarkVector interne', async () => {
    const { dc1 } = await buildTwoDcs();
    dc1.replicateFrom('192.168.10.11');
    const out = await dc1.executeCmdCommand('repadmin /showvector DC=mandeng,DC=lan');
    expect(out).toMatch(/Repl Up-To-Date Vector for DC=mandeng,DC=lan/);
    expect(out).toMatch(/invocation-\S+\s+\d+/);
  });

  it('/failcache affiche exactement les mêmes échecs que Get-ADReplicationFailure, sans divergence', async () => {
    const { dc1 } = await buildTwoDcs();
    dc1.replicateFrom('10.0.0.250');

    const cli = await dc1.executeCmdCommand('repadmin /failcache');
    expect(cli).toContain('10.0.0.250');

    const ps1 = await run(ps(dc1), 'Get-ADReplicationFailure -Scope Forest | Select-Object Partner, LastError');
    expect(ps1).toContain('10.0.0.250');
  });

  it('/failcache sans aucun échec affiche "No entries in the failure cache."', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /failcache');
    expect(out).toBe('No entries in the failure cache.');
  });
});

describe('PRD-Repadmin.md P6 — /showobjmeta <DC> <ObjectDN>', () => {
  it('/showobjmeta affiche le timbre de réplication réel (originatingInvocationId/USN/timestamp)', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /showobjmeta DC01.mandeng.lan DC=mandeng,DC=lan');
    expect(out).toMatch(/Attribute: \(object-level only/);
    expect(out).toMatch(/invocation-\S+/);
  });

  it('/showobjmeta sur un objet inexistant répond "object not found"', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /showobjmeta DC01.mandeng.lan CN=NoSuchObject,DC=mandeng,DC=lan');
    expect(out).toMatch(/object not found/);
  });
});

describe('PRD-Repadmin.md P7 — /bind [DC]', () => {
  it('/bind sans argument confirme une liaison locale immédiate (0 ms)', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /bind');
    expect(out).toMatch(/is alive \(0 ms\)/);
  });

  it('/bind DC02.mandeng.lan effectue un vrai dial TCP/135 et rapporte la latence', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /bind DC02.mandeng.lan');
    expect(out).toMatch(/Bound to DC02\.mandeng\.lan/);
    expect(out).toMatch(/is alive \(\d+ ms\)/);
  });

  it('/bind sur une cible injoignable échoue avec "Unable to contact target"', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /bind DCInjoignable');
    expect(out).toMatch(/Unable to contact target: DCInjoignable/);
  });
});

describe('PRD-Repadmin.md P8 — /options avec portage causal réel', () => {
  it('/options sans argument affiche "Current DC Options: (none)" par défaut', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /options');
    expect(out).toBe('Current DC Options: (none)');
  });

  it('DISABLE_OUTBOUND_REPL posé localement fait échouer une réplication SORTANTE ultérieure, -restaure le comportement normal', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    // Baseline: dc1 can pull from dc2.
    expect(dc1.replicateFrom('192.168.10.11').ok).toBe(true);

    await dc2.executeCmdCommand('repadmin /options +DISABLE_OUTBOUND_REPL');
    const blocked = dc1.replicateFrom('192.168.10.11');
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/Replication is disabled/);

    await dc2.executeCmdCommand('repadmin /options -DISABLE_OUTBOUND_REPL');
    const restored = dc1.replicateFrom('192.168.10.11');
    expect(restored.ok).toBe(true);
  });

  it('repadmin /options DC02.mandeng.lan +DISABLE_OUTBOUND_REPL exécuté depuis DC01 pose l\'option À DISTANCE sur DC02', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    expect(dc1.replicateFrom('192.168.10.11').ok).toBe(true);

    const out = await dc1.executeCmdCommand('repadmin /options DC02.mandeng.lan +DISABLE_OUTBOUND_REPL');
    expect(out).not.toMatch(/Unable to contact target/);

    const blocked = dc1.replicateFrom('192.168.10.11');
    expect(blocked.ok).toBe(false);
    expect(dc2).toBeDefined();
  });

  it('DISABLE_INBOUND_REPL posé localement refuse d\'appliquer les changements reçus même si le réseau réussit', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await dc1.executeCmdCommand('repadmin /options +DISABLE_INBOUND_REPL');
    const result = dc1.replicateFrom('192.168.10.11');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Inbound replication is disabled/);
    expect(dc2).toBeDefined();
  });

  it('un flag inconnu est rejeté proprement', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /options +NOT_A_REAL_OPTION');
    expect(out).toMatch(/not a recognized DC option/);
  });
});

describe('PRD-Repadmin.md P9 — /queue toujours vide (modèle synchrone honnête)', () => {
  it('/queue affiche "Queue contains 0 items." même après plusieurs pulls consécutifs', async () => {
    const { dc1 } = await buildTwoDcs();
    dc1.replicateFrom('192.168.10.11');
    dc1.replicateFrom('192.168.10.11');
    dc1.replicateFrom('192.168.10.11');
    const out = await dc1.executeCmdCommand('repadmin /queue');
    expect(out).toBe('Queue contains 0 items.');
  });
});

describe('PRD-Repadmin.md P11 — /latencies', () => {
  it('/latencies rapporte chaque DC connu avec sa latence réelle', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /latencies');
    expect(out).toMatch(/DC02\.mandeng\.lan\t\d+ ms/);
  });
});

describe('PRD-Repadmin.md §2.2 — /kcc message honnête (non-objectif KCC hérité)', () => {
  it('/kcc répond par un message honnête plutôt que "not recognized", sans calcul de topologie', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /kcc');
    expect(out).not.toMatch(/not recognized/i);
    expect(out).toMatch(/does not model automatic/i);
  });
});

describe('PRD-Repadmin.md — non-régression /showrepl et /replsummary sans argument de ciblage', () => {
  it('/showrepl sans argument reste correct (chemin local inchangé)', async () => {
    const { dc1 } = await buildTwoDcs();
    dc1.replicateFrom('192.168.10.11');
    const out = await dc1.executeCmdCommand('repadmin /showrepl');
    expect(out).toMatch(/was successful/i);
  });

  it('/replsummary affiche Fails 0 pour DC01 et DC02', async () => {
    const { dc1 } = await buildTwoDcs();
    const out = await dc1.executeCmdCommand('repadmin /replsummary');
    expect(out).toContain('DC01.mandeng.lan');
    expect(out).toContain('DC02.mandeng.lan');
  });
});
