import { describe, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'fs';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

const OUT = '/tmp/explore.txt';
writeFileSync(OUT, '');
const log = (...a: unknown[]) => appendFileSync(OUT, a.join(' ') + '\n');

describe('explore', () => {
  it('exit puis invite', async () => {
    const r = new CiscoRouter('Router', 0, 0);
    r.powerOn();
    await r.executeCommand('enable');
    log('exit =>', JSON.stringify(await r.executeCommand('exit')));
    log('prompt =>', JSON.stringify(await r.getPrompt()));
    log('privilege =>', JSON.stringify(await r.executeCommand('show privilege')));
  }, 120_000);

  it('mauvais mot de passe', async () => {
    const r = new CiscoRouter('Router', 0, 0);
    r.powerOn();
    for (const c of ['enable', 'configure terminal', 'enable secret supersecret', 'end', 'exit']) {
      await r.executeCommand(c);
    }
    log('apres exit prompt =>', JSON.stringify(await r.getPrompt()));
    log('enable+wrong =>', JSON.stringify(await r.executeCommand('enable\nwrongpassword')));
    log('prompt =>', JSON.stringify(await r.getPrompt()));
  }, 120_000);

  it('switch disable en mode user', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW', 26, 0, 0) as unknown as {
      powerOn(): void; executeCommand(c: string): Promise<string>; getPrompt(): Promise<string>;
    };
    s.powerOn();
    log('disable =>', JSON.stringify(await s.executeCommand('disable')));
    log('prompt =>', JSON.stringify(await s.getPrompt()));
    await s.executeCommand('enable');
    await s.executeCommand('configure terminal');
    log('crypto key generate rsa =>', JSON.stringify(await s.executeCommand('crypto key generate rsa')));
    log('ip domain-name x.y =>', JSON.stringify(await s.executeCommand('ip domain-name x.y')));
    log('crypto key generate rsa =>', JSON.stringify(await s.executeCommand('crypto key generate rsa')));
    log('sntp server 1.1.1.1 =>', JSON.stringify(await s.executeCommand('sntp server 1.1.1.1')));
  }, 120_000);
});
