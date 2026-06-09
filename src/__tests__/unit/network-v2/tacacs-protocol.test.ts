import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  PORT_TACACS, TACACS_TYPE, TACACS_AUTHEN_STATUS, TACACS_AUTHOR_STATUS,
  TACACS_AUTHEN_ACTION, TACACS_AUTHEN_TYPE, TACACS_AUTHEN_SERVICE,
} from '@/network/tacacs/types';
import { decryptBody } from '@/network/tacacs/encryption';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('TACACS+ — pure helpers', () => {
  it('TACACS_TYPE matches RFC 8907 packet-type assignments', () => {
    expect(TACACS_TYPE.authen).toBe(1);
    expect(TACACS_TYPE.author).toBe(2);
    expect(TACACS_TYPE.acct).toBe(3);
  });

  it('TACACS_AUTHEN_STATUS encodes pass=1 / fail=2 / error=7', () => {
    expect(TACACS_AUTHEN_STATUS.pass).toBe(1);
    expect(TACACS_AUTHEN_STATUS.fail).toBe(2);
    expect(TACACS_AUTHEN_STATUS.error).toBe(7);
  });

  it('TACACS_AUTHOR_STATUS encodes pass-add=1 / fail=0x10', () => {
    expect(TACACS_AUTHOR_STATUS['pass-add']).toBe(1);
    expect(TACACS_AUTHOR_STATUS.fail).toBe(0x10);
  });

  it('TACACS_AUTHEN_ACTION and SERVICE cover the standard values', () => {
    expect(TACACS_AUTHEN_ACTION.login).toBe(1);
    expect(TACACS_AUTHEN_TYPE.ascii).toBe(1);
    expect(TACACS_AUTHEN_SERVICE.login).toBe(1);
  });
});

function setupNasAndAaa(): { bus: EventBus; nas: CiscoRouter; aaa: CiscoRouter; sw: CiscoSwitch } {
  const bus = new EventBus();
  const nas = new CiscoRouter('NAS');
  const aaa = new CiscoRouter('AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); aaa.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
  new Cable('b').connect(aaa.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  aaa.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  aaa.getTacacsServer().setEnabled(true);
  return { bus, nas, aaa, sw };
}

describe('TACACS+ — authentication', () => {
  it('a registered user with the correct password gets status=pass and privLvl=15', async () => {
    const { nas, aaa } = setupNasAndAaa();
    aaa.getTacacsServer().addUser('alice', 'wonderland', 15);
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const out = await nas.getTacacsClient().authenticate('alice', 'wonderland');
    expect(out.status).toBe('pass');
    expect(out.privLvl).toBe(15);
  });

  it('the wrong password yields status=fail and privLvl=null', async () => {
    const { nas, aaa } = setupNasAndAaa();
    aaa.getTacacsServer().addUser('alice', 'wonderland');
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const out = await nas.getTacacsClient().authenticate('alice', 'wrong');
    expect(out.status).toBe('fail');
    expect(out.privLvl).toBeNull();
  });

  it('an unknown user yields status=fail', async () => {
    const { nas, aaa } = setupNasAndAaa();
    aaa.getTacacsServer().addUser('alice', 'wonderland');
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const out = await nas.getTacacsClient().authenticate('bob', 'whatever');
    expect(out.status).toBe('fail');
  });

  it('publishes tacacs.authen.completed with accurate status', async () => {
    const { bus, nas, aaa } = setupNasAndAaa();
    aaa.getTacacsServer().addUser('alice', 'wonderland');
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const completed: Array<{ username: string; status: string }> = [];
    bus.subscribe('tacacs.authen.completed', (e) => completed.push(e.payload));
    await nas.getTacacsClient().authenticate('alice', 'wonderland');
    expect(completed.length).toBe(1);
    expect(completed[0]).toMatchObject({ username: 'alice', status: 'pass' });
  });
});

describe('TACACS+ — authorization', () => {
  it('a user with no permittedCommands set is granted any command (pass-add)', async () => {
    const { nas, aaa } = setupNasAndAaa();
    aaa.getTacacsServer().addUser('alice', 'wonderland');
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const status = await nas.getTacacsClient().authorize('alice', 'show version');
    expect(status).toBe('pass-add');
  });

  it('a user with a non-empty permittedCommands allows only matching commands', async () => {
    const { nas, aaa } = setupNasAndAaa();
    aaa.getTacacsServer().addUser('alice', 'wonderland', 1, ['show version']);
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const ok = await nas.getTacacsClient().authorize('alice', 'show version');
    const ko = await nas.getTacacsClient().authorize('alice', 'reload');
    expect(ok).toBe('pass-add');
    expect(ko).toBe('fail');
  });
});

describe('TACACS+ — accounting', () => {
  it('start/stop records land in the server accounting log', async () => {
    const { nas, aaa } = setupNasAndAaa();
    aaa.getTacacsServer().addUser('alice', 'wonderland');
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const startStatus = await nas.getTacacsClient().accountCommand('alice', 'show version', ['start']);
    const stopStatus = await nas.getTacacsClient().accountCommand('alice', 'show version', ['stop']);
    expect(startStatus).toBe('success');
    expect(stopStatus).toBe('success');
    const log = aaa.getTacacsServer().getAccountingLog();
    expect(log.length).toBe(2);
    expect(log[0].user).toBe('alice');
    expect(log[0].cmd).toBe('show version');
    expect(log[0].flags).toContain('start');
    expect(log[1].flags).toContain('stop');
  });

  it('publishes tacacs.acct.completed for each accounting roundtrip', async () => {
    const { bus, nas, aaa } = setupNasAndAaa();
    aaa.getTacacsServer().addUser('alice', 'wonderland');
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const acct: Array<{ username: string; status: string; flags: string[] }> = [];
    bus.subscribe('tacacs.acct.completed', (e) => acct.push(e.payload));
    await nas.getTacacsClient().accountCommand('alice', 'configure terminal', ['start']);
    expect(acct.length).toBe(1);
    expect(acct[0]).toMatchObject({ username: 'alice', status: 'success' });
    expect(acct[0].flags).toContain('start');
  });
});

describe('TACACS+ — wire format', () => {
  it('AUTHEN-START rides TCP/49 with a tacacs payload', () => {
    const bus = new EventBus();
    const nas = new CiscoRouter('NAS');
    const aaa = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    nas.setEventBus(bus); aaa.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('a');
    cable.setEventBus(bus);
    let seen: { dport: number; bodyType: string; user: string; wireBodyType: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number;
        payload?: {
          type?: string; destinationPort?: number;
          payload?: { type?: string; header?: { sessionId: number; version: number; seqNo: number }; body?: { type?: string; cipherHex?: string; user?: string } }
        };
      } | undefined;
      const tcp = ipPkt?.payload;
      if (tcp?.type === 'tcp' && tcp.destinationPort === PORT_TACACS) {
        const tac = tcp.payload;
        if (tac?.type === 'tacacs' && tac.body?.type === 'tacacs-encrypted' && tac.header) {
          const json = decryptBody(tac.body.cipherHex!, tac.header.sessionId, 'shared', tac.header.version, tac.header.seqNo);
          if (json) {
            const decoded = JSON.parse(json) as { type: string; user: string };
            seen = { dport: tcp.destinationPort, wireBodyType: tac.body.type, bodyType: decoded.type, user: decoded.user };
          }
        }
      }
    });
    cable.connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(aaa.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    aaa.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    aaa.getTacacsServer().setEnabled(true);
    aaa.getTacacsServer().addUser('alice', 'wonderland');
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    nas.getTacacsClient().authenticate('alice', 'wonderland');

    expect(seen).not.toBeNull();
    expect(seen!.dport).toBe(PORT_TACACS);
    expect(seen!.wireBodyType).toBe('tacacs-encrypted');
    expect(seen!.bodyType).toBe('tacacs-authen-start');
    expect(seen!.user).toBe('alice');
  });
});

describe('TACACS+ — Cisco↔Huawei interop', () => {
  it('Huawei NAS authenticates against a Cisco TACACS+ server', async () => {
    const bus = new EventBus();
    const nas = new HuaweiRouter('HW-NAS');
    const aaa = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    nas.setEventBus(bus); aaa.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(nas.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(aaa.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    nas.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    aaa.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    aaa.getTacacsServer().setEnabled(true);
    aaa.getTacacsServer().addUser('alice', 'wonderland', 15);
    nas.getTacacsClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const out = await nas.getTacacsClient().authenticate('alice', 'wonderland');
    expect(out.status).toBe('pass');
  });
});

describe('TACACS+ — timeout', () => {
  it('returns timeout when no server replies', async () => {
    const nas = new CiscoRouter('NAS');
    nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nas.getTacacsClient().addServer('10.0.0.99', 'shared', { timeoutMs: 50 });
    const out = await nas.getTacacsClient().authenticate('alice', 'wonderland');
    expect(out.status).toBe('timeout');
  });
});
