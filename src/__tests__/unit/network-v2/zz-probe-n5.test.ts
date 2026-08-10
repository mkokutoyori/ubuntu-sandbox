import { describe, it, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import fs from 'fs';
const F = process.env.SP + '/n5.txt';
const log = (s: string) => fs.appendFileSync(F, s + '\n');
beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function paire(cleServeur: string, cleClient: string, authClient = true) {
  const srv = new CiscoRouter('SRV'); const cli = new CiscoRouter('CLI');
  new Cable('c').connect(srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
  for (const c of ['enable','configure terminal','interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0','no shutdown','exit',
    'ntp authenticate', `ntp authentication-key 1 md5 ${cleServeur}`, 'ntp trusted-key 1',
    'ntp master 2','end']) await srv.executeCommand(c);
  const cmds = ['enable','configure terminal','interface GigabitEthernet0/0',
    'ip address 10.0.0.2 255.255.255.0','no shutdown','exit'];
  if (authClient) cmds.push('ntp authenticate', `ntp authentication-key 1 md5 ${cleClient}`, 'ntp trusted-key 1');
  cmds.push('ntp server 10.0.0.1 key 1','end');
  for (const c of cmds) await cli.executeCommand(c);
  return { srv, cli };
}

describe('n5', () => {
  it('cles IDENTIQUES', async () => {
    const { cli } = await paire('MemeCle', 'MemeCle');
    log('=== cles identiques ===\n' + await cli.executeCommand('show ntp status'));
  });
  it('cles DIFFERENTES : le tuto attend un echec', async () => {
    const { cli } = await paire('CleServeur', 'CleClientDifferente');
    log('\n=== cles differentes ===\n' + await cli.executeCommand('show ntp status'));
    log(await cli.executeCommand('show ntp associations'));
  });
  it('client SANS aucune cle, serveur qui authentifie', async () => {
    const { cli } = await paire('CleServeur', '', false);
    log('\n=== client sans cle ===\n' + await cli.executeCommand('show ntp status'));
  });
});
