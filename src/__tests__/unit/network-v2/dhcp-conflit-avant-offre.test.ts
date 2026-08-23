/**
 * ISC — le defaut de `ping-check` est ATTESTE, et il est VRAI.
 *
 * Ce fichier tenait pour acquis que sans directive le controle n'a pas
 * lieu, et ecrivait ce defaut dans son cas « sans lui ». Le code d'ISC
 * dit l'inverse : `do_ping_check()` (`server/dhcp.c`) n'abandonne le
 * controle que si l'option EXISTE et vaut faux —
 * `if (oc && !evaluate_boolean_option_cache(...)) return (0);` —, donc
 * une option absente laisse le ping partir. La page de manuel du depot
 * (`server/dhcpd.conf.5`) dit la meme chose dans l'autre sens : « if its
 * value is false, no ping check is done ». Le parametre existe pour
 * ETEINDRE le controle, pas pour l'allumer.
 *
 * Deux moities, discriminees separement par neutralisation :
 * « SANS directive » tombe si le defaut redevient faux ; « dans le
 * sous-reseau » tombe si la recolte des blocs imbriques redevient un
 * cliquet a sens unique (`if (parser.pingCheck)`), qui ne pouvait que
 * MONTER la valeur — sans effet tant que le defaut etait faux, et qui
 * rendait `ping-check false;` inerte des qu'il devient vrai. Les deux
 * cas `false` explicites passent des deux cotes et sont la comme
 * non-regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

const SQUATTED = '10.0.0.10';
const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, line: string) =>
  (await sh.processLine(line)).output.join('\n');

async function poste(nom: string, sw: GenericSwitch, prise: number, adresse?: string) {
  const pc = new LinuxPC('linux-pc', nom);
  new Cable(`c-${nom}`).connect(pc.getPorts()[0], sw.getPorts()[prise]);
  pc.powerOn();
  if (adresse) {
    await pc.executeCommand(`ip addr add ${adresse}/24 dev eth0`);
    await pc.executeCommand('ip link set eth0 up');
  }
  return pc;
}

function adresseDe(pc: LinuxPC): string {
  return pc.getPorts()[0].getIPAddress()?.toString() ?? '';
}

// ─── Cisco ───────────────────────────────────────────────────────────

async function labCisco(pingPackets?: number) {
  const r = new CiscoRouter('R1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('up').connect(r.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
  const squatteur = await poste('SQUAT', sw, 1, SQUATTED);
  const client = await poste('CLI', sw, 2);
  const lignes = [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp excluded-address 10.0.0.1 10.0.0.9',
    ...(pingPackets === undefined ? [] : [`ip dhcp ping packets ${pingPackets}`]),
    'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0',
    'default-router 10.0.0.1', 'end',
  ];
  for (const l of lignes) await r.executeCommand(l);
  return { r, squatteur, client };
}

describe('IOS : le serveur SONDE avant d offrir', () => {
  it('l adresse tenue par un tiers n est pas distribuee', async () => {
    const { client } = await labCisco();

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).not.toBe(SQUATTED);
    expect(adresseDe(client)).toMatch(/^10\.0\.0\./);
  });

  it('elle entre au tableau des conflits, en nommant la sonde', async () => {
    const { r, client } = await labCisco();
    await client.executeCommand('dhclient eth0');

    const vu = await r.executeCommand('show ip dhcp conflict');

    expect(vu).toContain(SQUATTED);
    expect(vu.toLowerCase()).toContain('ping');
  });

  it('`ip dhcp ping packets 0` coupe la sonde, et l adresse part quand meme', async () => {
    const { client } = await labCisco(0);

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).toBe(SQUATTED);
  });

  it('sans squatteur, la premiere adresse de la plage est bien servie', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'SW');
    new Cable('up').connect(r.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
    const client = await poste('CLI', sw, 2);
    for (const l of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 10.0.0.1 10.0.0.9',
      'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'end']) {
      await r.executeCommand(l);
    }

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).toBe(SQUATTED);
  });
});

// ─── Windows ─────────────────────────────────────────────────────────

async function labWindows() {
  const srv = new WindowsServer('SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('up').connect(srv.getPorts()[0], sw.getPorts()[0]);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.setCurrentUser('Administrator');
  const squatteur = await poste('SQUAT', sw, 1, SQUATTED);
  const client = await poste('CLI', sw, 2);
  const sh = ps(srv);
  await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
  await run(sh, 'Add-DhcpServerv4Scope -Name LAN -StartRange 10.0.0.10 '
    + '-EndRange 10.0.0.50 -SubnetMask 255.255.255.0 -State Active');
  return { srv, sh, squatteur, client };
}

describe('Windows : la detection de conflit est un REGLAGE, eteint par defaut', () => {
  it('le reglage par defaut est zero tentative', async () => {
    const { sh } = await labWindows();

    const vu = await run(sh, 'Get-DhcpServerSetting');

    expect(vu).toContain('ConflictDetectionAttempts');
    expect(vu).toMatch(/ConflictDetectionAttempts\s*:?\s*0/);
  });

  it('eteinte, l adresse squattee est distribuee — comme sur un vrai Windows', async () => {
    const { client } = await labWindows();

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).toBe(SQUATTED);
  });

  it('allumee, elle ne l est plus', async () => {
    const { sh, client } = await labWindows();
    await run(sh, 'Set-DhcpServerSetting -ConflictDetectionAttempts 2');

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).not.toBe(SQUATTED);
    expect(adresseDe(client)).toMatch(/^10\.0\.0\./);
  });

  it('le reglage se relit apres avoir ete pose', async () => {
    const { sh } = await labWindows();
    await run(sh, 'Set-DhcpServerSetting -ConflictDetectionAttempts 3');

    expect(await run(sh, 'Get-DhcpServerSetting'))
      .toMatch(/ConflictDetectionAttempts\s*:?\s*3/);
  });

  it('au-dela de six, le reglage est refuse', async () => {
    const { sh } = await labWindows();

    const vu = await run(sh, 'Set-DhcpServerSetting -ConflictDetectionAttempts 9');

    expect(vu).toMatch(/maximum allowed range of 6/i);
    expect(await run(sh, 'Get-DhcpServerSetting'))
      .toMatch(/ConflictDetectionAttempts\s*:?\s*0/);
  });
});

// ─── Linux (ISC) ─────────────────────────────────────────────────────

type FormePingCheck = 'absente' | 'globale-vraie' | 'globale-fausse' | 'sous-reseau-fausse';

async function labLinux(forme: FormePingCheck) {
  const srv = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('up').connect(srv.getPorts()[0], sw.getPorts()[0]);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.powerOn();
  const squatteur = await poste('SQUAT', sw, 1, SQUATTED);
  const client = await poste('CLI', sw, 2);
  const global = forme === 'globale-vraie' ? 'ping-check true;\n'
    : forme === 'globale-fausse' ? 'ping-check false;\n' : '';
  const local = forme === 'sous-reseau-fausse' ? '  ping-check false;\n' : '';
  const conf = `${global}
subnet 10.0.0.0 netmask 255.255.255.0 {
${local}  range 10.0.0.10 10.0.0.50;
  option routers 10.0.0.1;
}
`;
  await srv.executeCommand(`printf '%s' ${JSON.stringify(conf)} > /etc/dhcp/dhcpd.conf`);
  await srv.executeCommand('sudo systemctl start isc-dhcp-server');
  return { srv, squatteur, client };
}

describe('ISC : `ping-check` s ecrit dans dhcpd.conf', () => {
  it('`ping-check false;` distribue l adresse squattee', async () => {
    const { client } = await labLinux('globale-fausse');

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).toBe(SQUATTED);
  });

  it('SANS directive le controle a lieu quand meme — le defaut d ISC', async () => {
    const { client } = await labLinux('absente');

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).not.toBe(SQUATTED);
  });

  it('`ping-check false;` dans le sous-reseau eteint le controle', async () => {
    const { client } = await labLinux('sous-reseau-fausse');

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).toBe(SQUATTED);
  });

  it('avec lui, elle est ABANDONNEE et une autre est servie', async () => {
    const { client } = await labLinux('globale-vraie');

    await client.executeCommand('dhclient eth0');

    expect(adresseDe(client)).not.toBe(SQUATTED);
    expect(adresseDe(client)).toMatch(/^10\.0\.0\./);
  });

  it('le journal le dit dans les mots du vrai demon', async () => {
    const { srv, client } = await labLinux('globale-vraie');
    await client.executeCommand('dhclient eth0');

    const vu = await srv.executeCommand('journalctl -u isc-dhcp-server');

    expect(vu).toContain(`Abandoning IP address ${SQUATTED}: pinged before offer`);
  });

  it('`dhcpd -t` accepte la forme et ne s en plaint pas', async () => {
    const { srv } = await labLinux('globale-vraie');

    const vu = await srv.executeCommand('sudo dhcpd -t');

    expect(vu).not.toMatch(/unknown parameter|semicolon expected/);
    expect(vu).toContain('Config file: /etc/dhcp/dhcpd.conf');
  });

  it('une adresse LIBRE de la plage n est jamais abandonnee', async () => {
    const { srv, client } = await labLinux('globale-vraie');
    await client.executeCommand('dhclient eth0');

    const vu = await srv.executeCommand('journalctl -u isc-dhcp-server');
    const abandonnees = vu.split('\n').filter(l => l.includes('Abandoning IP address'));

    expect(abandonnees.length).toBe(1);
    expect(abandonnees[0]).toContain(SQUATTED);
  });
});
