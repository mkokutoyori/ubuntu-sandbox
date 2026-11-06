/*
 * In the DNS lab, 'systeminfo /s dc1.horizon.local', 'getmac /s', 'tasklist /s' and 'schtasks /query /s' typed on PC-GUICHET1 printed the data of PC-GUICHET1: the
 * /s (remote machine), /u and /p switches were never read, so no frame left the machine (rule 4) and a name that does not exist answered like a real one.
 * Now the switches are parsed once (windows/WinRemoteTarget.ts), the name goes through the machine's resolver, and the command runs on the remote machine over the
 * existing WinRM channel (TCP 5985, real frames, the remote side authenticates and decides): systeminfo and getmac show DC1, an unknown name or a closed port
 * answers 'ERROR: The RPC server is unavailable.', a missing or wrong credential 'ERROR: Access is denied.'. Limit stated: real Windows carries these tools over
 * RPC/DCOM, not WinRM; this simulator has no RPC endpoint mapper, so the one remote-execution channel it has is reused and WinRM must be enabled on the target.
 *
 * Reference (official_docs/microsoft/windows-server/windows-commands): '/u' and '/p' belong to '/s <computer> [/u [/p]]'; tasklist and taskkill state that /u 'can be specified only if /s is also specified'. The four
 * added cases check that, with the generic 'ERROR: Invalid syntax.' wording (the page does not give the message). They fall at base (the switch was ignored and the command ran locally).
 * Measured against the commit before (worktree): 5 of the first 7 cases fall (systeminfo, getmac and tasklist show the local machine, an unknown name and a wrong password are answered with local data); the 2 that pass either way are the WITNESSES: the local 'systeminfo' and 'systeminfo /s localhost' (which real Windows runs locally).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

interface Shell { executeCommand(command: string): Promise<string> }

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

async function lab() {
  await buildDnsAgenceBancaire();
  const find = (name: string) => [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === name) as unknown as Shell;
  const server = find('DC1');
  await server.executeCommand('powershell -Command "Enable-PSRemoting -Force"');
  await server.executeCommand('net user rmt P@ssw0rd1 /add');
  await server.executeCommand('net localgroup Administrators rmt /add');
  return find('PC-GUICHET1');
}

const TARGET = 'dc1.horizon.local /u rmt /p P@ssw0rd1';

describe('remote switches of the Windows tools', () => {
  it('WITNESS systeminfo without /s shows the local machine', async () => {
    expect(await (await lab()).executeCommand('systeminfo')).toContain('PC-GUICHET1');
  });

  it('WITNESS systeminfo /s localhost runs locally', async () => {
    expect(await (await lab()).executeCommand('systeminfo /s localhost')).toContain('PC-GUICHET1');
  });

  it('systeminfo /s shows the remote machine', async () => {
    const out = await (await lab()).executeCommand(`systeminfo /s ${TARGET}`);
    expect(out).toContain('Host Name:                 DC1');
    expect(out).not.toContain('PC-GUICHET1');
  });

  it('getmac /s shows the remote adapters, not the local ones', async () => {
    const pc = await lab();
    const local = await pc.executeCommand('getmac');
    const remote = await pc.executeCommand(`getmac /s ${TARGET}`);
    expect(remote).toContain('Physical Address');
    expect(remote).not.toBe(local);
  });

  it('tasklist /s lists the remote processes', async () => {
    const pc = await lab();
    const out = await pc.executeCommand(`tasklist /s ${TARGET}`);
    expect(out).toContain('Image Name');
    expect(out).not.toBe(await pc.executeCommand('tasklist'));
  });

  it('a name nobody knows answers like an unreachable RPC server', async () => {
    expect(await (await lab()).executeCommand('systeminfo /s nobody.horizon.local')).toContain('The RPC server is unavailable.');
  });

  it('a wrong password is refused by the remote machine', async () => {
    expect(await (await lab()).executeCommand('systeminfo /s dc1.horizon.local /u rmt /p wrong')).toContain('ERROR');
  });

  it.each(['tasklist /u rmt', 'taskkill /u rmt /im x.exe', 'getmac /p secret', 'systeminfo /u rmt /p secret'])('%s without /s is a syntax error (reference: /u only with /s)', async (line) => {
    const out = await (await lab()).executeCommand(line);
    expect(out).toContain('ERROR: Invalid syntax.');
  });
});
