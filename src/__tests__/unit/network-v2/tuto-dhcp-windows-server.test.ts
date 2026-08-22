import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { getDefaultEventBus } from '@/events/EventBus';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, line: string) =>
  (await sh.processLine(line)).output.join('\n');

const SCOPE_MULTILINE = [
  'Add-DhcpServerv4Scope `',
  '    -Name "LAN-40" `',
  '    -StartRange 192.168.40.10 `',
  '    -EndRange 192.168.40.200 `',
  '    -SubnetMask 255.255.255.0 `',
  '    -State Active',
].join('\n');

function buildLab() {
  const srv = new WindowsServer('SRV-DHCP');
  const winClient = new WindowsPC('windows-pc', 'PC-WIN');
  const linuxClient = new LinuxPC('linux-pc', 'PC-LNX');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(winClient.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(linuxClient.getPorts()[0], sw.getPorts()[2]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.40.5'), new SubnetMask('255.255.255.0'));
  srv.setCurrentUser('Administrator');
  return { srv, winClient, linuxClient, sw };
}

async function installAndScope(srv: WindowsServer) {
  const sh = ps(srv);
  await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
  await run(sh, SCOPE_MULTILINE);
  await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -Router 192.168.40.1');
  await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -DnsServer 192.168.40.5 -DnsDomain "domain.local"');
  return sh;
}

describe('tuto DHCP §1 — installer le role', () => {
  it('Install-WindowsFeature -Name DHCP -IncludeManagementTools reussit', async () => {
    const { srv } = buildLab();
    const out = await run(ps(srv), 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    expect(out).toMatch(/Success/);
    expect(out).toMatch(/DHCP Server/);
  });

  it('Get-DhcpServerv4Scope est inconnue tant que le role n est pas installe', async () => {
    const { srv } = buildLab();
    const out = await run(ps(srv), 'Get-DhcpServerv4Scope');
    expect(out).toMatch(/not recognized/i);
  });

  it('Get-WindowsFeature DHCP rend l etat Installed', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    const out = await run(sh, 'Get-WindowsFeature DHCP');
    expect(out).toMatch(/DHCP/);
    expect(out).toMatch(/Installed/);
  });
});

describe('tuto DHCP §2 — autorisation dans l annuaire', () => {
  it('Get-DhcpServerInDC rend le nom et l adresse DECLARES a Add-DhcpServerInDC', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, 'Add-DhcpServerInDC -DnsName "SRV-DHCP.domain.local" -IpAddress 192.168.40.5');
    const out = await run(sh, 'Get-DhcpServerInDC');
    expect(out).toContain('SRV-DHCP.domain.local');
    expect(out).toContain('192.168.40.5');
  });

  it('Get-DhcpServerInDC ne rend rien avant tout enregistrement', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    const out = await run(sh, 'Get-DhcpServerInDC');
    expect(out.trim()).toBe('');
  });
});

describe('tuto DHCP §3 — creer le scope', () => {
  it('la forme MULTI-LIGNE du tutoriel (accent grave) cree le scope', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    const out = await run(sh, SCOPE_MULTILINE);
    expect(out).not.toMatch(/not recognized/i);
    const scopes = await run(sh, 'Get-DhcpServerv4Scope');
    expect(scopes).toContain('LAN-40');
    expect(scopes).toContain('192.168.40.10');
    expect(scopes).toContain('192.168.40.200');
  });

  it('le ScopeId rendu est l ADRESSE RESEAU, pas le nom du scope', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, SCOPE_MULTILINE);
    const out = await run(sh, 'Get-DhcpServerv4Scope');
    expect(out).toMatch(/ScopeId\s*:\s*192\.168\.40\.0/);
  });

  it('-State Active est rendu', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, SCOPE_MULTILINE);
    expect(await run(sh, 'Get-DhcpServerv4Scope')).toMatch(/State\s*:\s*Active/);
  });
});

describe('tuto DHCP §4-5 — passerelle et DNS par ScopeId', () => {
  it('Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -Router est accepte', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, SCOPE_MULTILINE);
    const out = await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -Router 192.168.40.1');
    expect(out).not.toMatch(/does not exist/i);
  });

  it('un ScopeId INEXISTANT est refuse', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, SCOPE_MULTILINE);
    const out = await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 10.99.99.0 -Router 10.99.99.1');
    expect(out).toMatch(/does not exist/i);
  });
});

describe('tuto DHCP §6 — verifier la configuration', () => {
  it('Get-DhcpServerv4OptionValue -ScopeId rend Router, DNS et domaine', async () => {
    const { srv } = buildLab();
    const sh = await installAndScope(srv);
    const out = await run(sh, 'Get-DhcpServerv4OptionValue -ScopeId 192.168.40.0');
    expect(out).toContain('192.168.40.1');
    expect(out).toContain('192.168.40.5');
    expect(out).toContain('domain.local');
  });
});

describe('tuto DHCP §7 — le service', () => {
  it('Get-Service DHCPServer le montre en marche', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    const out = await run(sh, 'Get-Service DHCPServer');
    expect(out).toMatch(/DHCPServer/);
    expect(out).toMatch(/Running/);
  });

  it('Set-Service DHCPServer -StartupType Automatic est accepte', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    const out = await run(sh, 'Set-Service DHCPServer -StartupType Automatic');
    expect(out).not.toMatch(/not recognized|Cannot find/i);
  });
});

describe('tuto DHCP §8 — le client obtient son bail', () => {
  it('ipconfig /renew donne une adresse DANS la plage annoncee', async () => {
    const { srv, winClient } = buildLab();
    await installAndScope(srv);
    const cli = ps(winClient);
    await run(cli, 'ipconfig /release');
    const out = await run(cli, 'ipconfig /renew');
    const m = /IPv4 Address[. ]*:\s*(\d+\.\d+\.\d+\.\d+)/.exec(out);
    expect(m).not.toBeNull();
    const last = Number(m![1].split('.')[3]);
    expect(m![1].startsWith('192.168.40.')).toBe(true);
    expect(last).toBeGreaterThanOrEqual(10);
    expect(last).toBeLessThanOrEqual(200);
  });

  it('ipconfig /all rend la passerelle, le SERVEUR DHCP et le DNS du tutoriel', async () => {
    const { srv, winClient } = buildLab();
    await installAndScope(srv);
    const cli = ps(winClient);
    await run(cli, 'ipconfig /release');
    await run(cli, 'ipconfig /renew');
    const out = await run(cli, 'ipconfig /all');
    expect(out).toMatch(/Default Gateway[. ]*:\s*192\.168\.40\.1/);
    expect(out).toMatch(/DHCP Server[. ]*:\s*192\.168\.40\.5/);
    expect(out).toMatch(/DNS Servers[. ]*:\s*192\.168\.40\.5/);
  });

  it('le bail remonte dans Get-DhcpServerv4Lease -ScopeId 192.168.40.0', async () => {
    const { srv, winClient } = buildLab();
    const sh = await installAndScope(srv);
    const cli = ps(winClient);
    await run(cli, 'ipconfig /release');
    await run(cli, 'ipconfig /renew');
    const out = await run(sh, 'Get-DhcpServerv4Lease -ScopeId 192.168.40.0');
    expect(out).toMatch(/192\.168\.40\.\d+/);
    expect(out).toMatch(/ScopeId\s*:\s*192\.168\.40\.0/);
  });

  it('un client Linux du meme segment est servi par le meme scope', async () => {
    const { srv, linuxClient } = buildLab();
    await installAndScope(srv);
    await linuxClient.executeCommand('dhclient eth0');
    const ip = linuxClient.getPorts()[0].getIPAddress()?.toString() ?? '';
    expect(ip.startsWith('192.168.40.')).toBe(true);
  });
});

describe('tuto DHCP — note finale : relais via ip helper-address', () => {
  it('un client d un AUTRE sous-reseau est servi quand le routeur Cisco relaie', async () => {
    const srv = new WindowsServer('SRV-DHCP');
    const router = new CiscoRouter('R1');
    const remote = new LinuxPC('linux-pc', 'PC-DISTANT');
    const swServer = new GenericSwitch('switch-generic', 'SW-SRV');
    const swRemote = new GenericSwitch('switch-generic', 'SW-REM');

    new Cable('c1').connect(srv.getPorts()[0], swServer.getPorts()[0]);
    new Cable('c2').connect(router.getPorts()[0], swServer.getPorts()[1]);
    new Cable('c3').connect(router.getPorts()[1], swRemote.getPorts()[0]);
    new Cable('c4').connect(remote.getPorts()[0], swRemote.getPorts()[1]);

    srv.getPorts()[0].configureIP(new IPAddress('192.168.40.5'), new SubnetMask('255.255.255.0'));
    srv.setDefaultGateway(new IPAddress('192.168.40.1'));
    srv.setCurrentUser('Administrator');
    router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.40.1'), new SubnetMask('255.255.255.0'));
    router.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.50.1'), new SubnetMask('255.255.255.0'));

    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, 'Add-DhcpServerv4Scope -Name "LAN-50" -StartRange 192.168.50.10 -EndRange 192.168.50.200 -SubnetMask 255.255.255.0 -State Active');
    await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.50.0 -Router 192.168.50.1');

    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand('ip helper-address 192.168.40.5');
    await router.executeCommand('end');

    await remote.executeCommand('dhclient eth0');
    const ip = remote.getPorts()[0].getIPAddress()?.toString() ?? '';
    expect(ip.startsWith('192.168.50.')).toBe(true);
  });
});

describe('DHCP Windows — le serveur ne propose jamais sa PROPRE adresse', () => {
  it('un scope couvrant l adresse du serveur ne la distribue pas', async () => {
    const { srv, winClient } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, 'Add-DhcpServerv4Scope -Name "LARGE" -StartRange 192.168.40.1 -EndRange 192.168.40.20 -SubnetMask 255.255.255.0 -State Active');
    await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -Router 192.168.40.1');

    const cli = ps(winClient);
    await run(cli, 'ipconfig /release');
    await run(cli, 'ipconfig /renew');
    const out = await run(cli, 'ipconfig /all');
    const m = /IPv4 Address[. ]*:\s*(\d+\.\d+\.\d+\.\d+)/.exec(out);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe('192.168.40.5');
    expect(m![1].startsWith('192.168.40.')).toBe(true);
  });
});

describe('DHCP Windows — Get-DhcpServerv4Binding', () => {
  it('liste les interfaces REELLES du serveur avec leur adresse', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    const out = await run(sh, 'Get-DhcpServerv4Binding');
    expect(out).toContain('192.168.40.5');
    expect(out).toMatch(/255\.255\.255\.0/);
  });

  it('est inconnue tant que le role n est pas installe', async () => {
    const { srv } = buildLab();
    const out = await run(ps(srv), 'Get-DhcpServerv4Binding');
    expect(out).toMatch(/not recognized/i);
  });
});

describe('DHCP Windows — un relais injoignable ne echoue plus en SILENCE', () => {
  it('publie dhcp.server.reply-undeliverable quand aucune route ne mene au relais', async () => {
    const srv = new WindowsServer('SRV-DHCP');
    const router = new CiscoRouter('R1');
    const remote = new LinuxPC('linux-pc', 'PC-DISTANT');
    const swServer = new GenericSwitch('switch-generic', 'SW-SRV');
    const swRemote = new GenericSwitch('switch-generic', 'SW-REM');
    new Cable('c1').connect(srv.getPorts()[0], swServer.getPorts()[0]);
    new Cable('c2').connect(router.getPorts()[0], swServer.getPorts()[1]);
    new Cable('c3').connect(router.getPorts()[1], swRemote.getPorts()[0]);
    new Cable('c4').connect(remote.getPorts()[0], swRemote.getPorts()[1]);
    srv.getPorts()[0].configureIP(new IPAddress('192.168.40.5'), new SubnetMask('255.255.255.0'));
    srv.setCurrentUser('Administrator');
    router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.40.1'), new SubnetMask('255.255.255.0'));
    router.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.50.1'), new SubnetMask('255.255.255.0'));

    const seen: Array<Record<string, unknown>> = [];
    getDefaultEventBus().subscribe('dhcp.server.reply-undeliverable',
      (e: { payload: Record<string, unknown> }) => seen.push(e.payload));

    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, 'Add-DhcpServerv4Scope -Name "LAN-50" -StartRange 192.168.50.10 -EndRange 192.168.50.200 -SubnetMask 255.255.255.0 -State Active');
    await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.50.0 -Router 192.168.50.1');

    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand('ip helper-address 192.168.40.5');
    await router.executeCommand('end');

    await remote.executeCommand('dhclient eth0');

    expect(remote.getPorts()[0].getIPAddress()?.toString() ?? '').not.toMatch(/^192\.168\.50\./);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].relayAgent).toBe('192.168.50.1');
    expect(seen[0].reason).toBe('no-route-to-relay');
    expect(seen[0].offeredIp).toBe('192.168.50.10');
  });
});

describe('DHCP Windows — enregistrement DNS dynamique du bail', () => {
  async function labWithDns() {
    const { srv, winClient, linuxClient } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DNS -IncludeManagementTools');
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    await run(sh, 'Add-DnsServerPrimaryZone -Name "lab.local"');
    await run(sh, 'Add-DhcpServerv4Scope -Name "LAN-40" -StartRange 192.168.40.10 -EndRange 192.168.40.200 -SubnetMask 255.255.255.0 -State Active');
    await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -Router 192.168.40.1');
    await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -DnsServer 192.168.40.5 -DnsDomain "lab.local"');
    return { srv, winClient, linuxClient, sh };
  }

  it('les reglages par defaut sont ceux de Windows', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    const out = await run(sh, 'Get-DhcpServerv4DnsSetting');
    expect(out).toContain('DynamicUpdates');
    expect(out).toContain('OnClientRequest');
    expect(out).toMatch(/True/);
  });

  it('une valeur hors de l ensemble est refusee', async () => {
    const { srv } = buildLab();
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
    const out = await run(sh, 'Set-DhcpServerv4DnsSetting -DynamicUpdates Parfois');
    expect(out).toMatch(/does not belong to the set/i);
  });

  it('un bail accorde CREE l enregistrement A dans la zone', async () => {
    const { winClient, sh } = await labWithDns();
    const cli = ps(winClient);
    await run(cli, 'ipconfig /release');
    await run(cli, 'ipconfig /renew');

    const records = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(records.toLowerCase()).toContain('pc-win');
    expect(records).toMatch(/192\.168\.40\.\d+/);
  });

  it('TEMOIN — par defaut, le SERVEUR enregistre le client qui le lui demande', async () => {
    const { linuxClient, sh } = await labWithDns();
    await linuxClient.executeCommand('dhclient eth0');
    const records = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(records.toLowerCase()).toContain('pc-lnx');
  });

  it('DynamicUpdates Never empeche le SERVEUR d enregistrer', async () => {
    const { linuxClient, sh } = await labWithDns();
    await run(sh, 'Set-DhcpServerv4DnsSetting -DynamicUpdates Never');
    await linuxClient.executeCommand('dhclient eth0');
    const records = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(records.toLowerCase()).not.toContain('pc-lnx');
  });

  it('Never ne peut rien contre un client qui s enregistre LUI-MEME', async () => {
    const { winClient, sh } = await labWithDns();
    await run(sh, 'Set-DhcpServerv4DnsSetting -DynamicUpdates Never');
    const cli = ps(winClient);
    await run(cli, 'ipconfig /release');
    await run(cli, 'ipconfig /renew');
    const records = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(records.toLowerCase()).toContain('pc-win');
  });

  it('sans role DNS sur la machine, le bail est accorde quand meme', async () => {
    const { srv, winClient } = buildLab();
    const sh = await installAndScope(srv);
    const cli = ps(winClient);
    await run(cli, 'ipconfig /release');
    const out = await run(cli, 'ipconfig /renew');
    expect(out).toMatch(/192\.168\.40\./);
    void sh;
  });
});
