import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

type Cli = { cliHelp(input: string): string; executeCommand(line: string): Promise<string> };

let serial = 0;

async function inGlobalConfig(): Promise<Cli> {
  const router = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  return router;
}

function offeredKeywords(help: string): string[] {
  return help.split('\n')
    .map(line => /^\s\s(\S+)/.exec(line)?.[1])
    .filter((word): word is string => word !== undefined);
}

describe('a migrated keyword is not an argument of its parent', () => {
  it('`logging delimiter ?` offers what follows delimiter, not what follows logging', async () => {
    const router = await inGlobalConfig();

    expect(offeredKeywords(router.cliHelp('logging delimiter '))).toEqual(['tcp']);
  });

  it('the siblings it used to leak are still offered one level up', async () => {
    const router = await inGlobalConfig();

    const oneLevelUp = offeredKeywords(router.cliHelp('logging '));

    for (const sibling of ['buffered', 'console', 'host', 'monitor', 'on', 'trap']) {
      expect(oneLevelUp, sibling).toContain(sibling);
    }
  });

  it('`logging rate-limit ?` keeps `except` for after the rate, where it is typed', async () => {
    const router = await inGlobalConfig();

    expect(offeredKeywords(router.cliHelp('logging rate-limit '))).not.toContain('except');
    expect(offeredKeywords(router.cliHelp('logging rate-limit 10 '))).toContain('except');
  });

  it('the migrated path stays out of the trie — the invariant is untouched', async () => {
    const router = new CiscoRouter('R-guard') as unknown as {
      getShell(): { enumerateAllExecutablePaths(): string[]; migratedPaths(): readonly string[] };
    };
    const shell = router.getShell();
    const executable = new Set(shell.enumerateAllExecutablePaths());

    expect(shell.migratedPaths()).toContain('logging delimiter');
    expect(executable.has('logging delimiter')).toBe(false);
  });

  it('a pruned parent still carries its unmigrated children', () => {
    const trie = new CommandTrie();
    trie.register('clear logging', 'Clear the buffer', () => 'buffer');
    trie.register('clear logging persistent', 'Clear the files', () => 'files');

    trie.prunePaths(['clear logging']);

    expect(trie.enumerateExecutablePaths()).toContain('clear logging persistent');
    expect(trie.enumerateExecutablePaths()).not.toContain('clear logging');
  });
});

describe('`logging history` requires its severity and drops it to negate', () => {
  it('`?` announces the severities and `size`, never `<cr>`', async () => {
    const router = await inGlobalConfig();

    const offered = offeredKeywords(router.cliHelp('logging history '));

    expect(offered).toContain('size');
    expect(offered).toContain('warnings');
    expect(offered).toContain('<0-7>');
    expect(offered).not.toContain('<cr>');
  });

  it('and the bare form is refused, as `?` promised', async () => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand('logging history')).toContain('Incomplete');
  });

  it('a severity is accepted by name and by number', async () => {
    const byName = await inGlobalConfig();
    const byNumber = await inGlobalConfig();

    expect(await byName.executeCommand('logging history errors')).not.toContain('Invalid');
    expect(await byNumber.executeCommand('logging history 3')).not.toContain('Invalid');
    expect(await byNumber.executeCommand('do show running-config'))
      .toContain('logging history errors');
  });

  it('`size` takes the severity place rather than following it', async () => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand('logging history size 10')).not.toContain('Invalid');
    expect(await router.executeCommand('logging history size')).toContain('Incomplete');
  });

  it('`no logging history` needs no severity — the form every operator types', async () => {
    const router = await inGlobalConfig();
    await router.executeCommand('logging history alerts');

    expect(await router.executeCommand('no logging history')).not.toContain('Invalid');
    expect(await router.executeCommand('do show running-config'))
      .not.toContain('logging history alerts');
  });

  it('the short form exists ONLY negated — the witness', async () => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand('no logging history')).not.toContain('Incomplete');
    expect(await router.executeCommand('logging history')).toContain('Incomplete');
  });
});

describe('`no` drops the argument where IOS drops it, and only there', () => {
  it.each([
    'trap', 'facility', 'source-interface', 'snmp-trap',
    'exception', 'queue-limit', 'origin-id',
  ])('`no logging %s` needs no argument', async (keyword) => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand(`no logging ${keyword}`)).toBe('');
  });

  it.each(['delimiter', 'message-counter', 'host'])(
    '`no logging %s` still names what it removes', async (keyword) => {
      const router = await inGlobalConfig();

      expect(await router.executeCommand(`no logging ${keyword}`)).toContain('Incomplete');
    });

  it('the positive form keeps requiring its argument — the witness', async () => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand('logging trap')).toContain('Incomplete');
    expect(await router.executeCommand('logging facility')).toContain('Incomplete');
  });

  it('and the negation really resets, it does not merely parse', async () => {
    const router = await inGlobalConfig();
    await router.executeCommand('logging trap 3');
    await router.executeCommand('logging facility local0');

    expect(await router.executeCommand('do show running-config'))
      .toContain('logging facility local0');

    await router.executeCommand('no logging trap');
    await router.executeCommand('no logging facility');

    const after = await router.executeCommand('do show running-config');
    expect(after).not.toContain('logging facility local0');
    expect(after).not.toContain('logging trap errors');
  });
});

describe('the bridge crosses in the NEGATIVE direction too', () => {
  it.each([
    ['no logging ', 'buffered'],
    ['no ntp ', 'server'],
    ['no clock ', 'timezone'],
  ])('`%s?` lists what the socle knows how to undo', async (input, expected) => {
    const router = await inGlobalConfig();

    expect(offeredKeywords(router.cliHelp(input))).toContain(expected);
  });

  it('a command the socle cannot undo announces nothing — and refuses too', async () => {
    const router = await inGlobalConfig();

    expect(offeredKeywords(router.cliHelp('no clock '))).not.toContain('set');
    expect(await router.executeCommand('no clock set 10:00:00'))
      .toContain('Invalid input');
  });

  it('and `no snmp-server` is now on the other side of that rule', async () => {
    const router = await inGlobalConfig();

    expect(offeredKeywords(router.cliHelp('no snmp-server '))).toContain('community');
    await router.executeCommand('snmp-server community public RO');
    expect(await router.executeCommand('no snmp-server community public'))
      .not.toContain('Invalid input');
    expect(await router.executeCommand('do show running-config'))
      .not.toContain('snmp-server community public');
  });

  it('`no` borrows the undo wording where the command declares one', async () => {
    const router = await inGlobalConfig();
    await router.executeCommand('interface GigabitEthernet0/0');

    expect(router.cliHelp('no ipv6 nd ')).toContain('Clear the M flag');
    expect(router.cliHelp('ipv6 nd ')).toContain('Set the M flag');
  });
});

describe('`ip` is not an abbreviation of `ipv6`', () => {
  async function onInterface(): Promise<Cli> {
    const router = await inGlobalConfig();
    await router.executeCommand('interface GigabitEthernet0/0');
    return router;
  }

  it('`ip ospf cost 50` reaches IPv4, though only `ipv6` is on the socle', async () => {
    const router = await onInterface();

    expect(await router.executeCommand('ip ospf cost 50')).not.toContain('Invalid');
    expect(await router.executeCommand('ip ospf priority 7')).not.toContain('Invalid');
  });

  it('and `ip ospf ?` describes OSPF, not OSPFv3', async () => {
    const router = await onInterface();

    expect(router.cliHelp('ip ospf ')).toContain('Set OSPF cost on interface');
    expect(router.cliHelp('ip ospf ')).not.toContain('OSPFv3');
  });

  it('an incomplete OSPFv3 command says so instead of blaming `ospf`', async () => {
    const router = await onInterface();

    expect(await router.executeCommand('ipv6 ospf cost')).toBe('% Incomplete command.');
  });
});

describe('the OSPFv3 interface family answers from the socle', () => {
  async function onInterface(): Promise<Cli> {
    const router = await inGlobalConfig();
    await router.executeCommand('ipv6 unicast-routing');
    await router.executeCommand('interface GigabitEthernet0/0');
    await router.executeCommand('ipv6 address 2001:db8::1/64');
    await router.executeCommand('no shutdown');
    return router;
  }

  it('`ipv6 ospf ?` offers the process id alongside the settings', async () => {
    const router = await onInterface();

    const offered = offeredKeywords(router.cliHelp('ipv6 ospf '));

    expect(offered).toContain('<1-65535>');
    for (const setting of ['cost', 'priority', 'hello-interval', 'dead-interval', 'network']) {
      expect(offered, setting).toContain(setting);
    }
  });

  it('the network types are named rather than swallowed as free text', async () => {
    const router = await onInterface();

    expect(offeredKeywords(router.cliHelp('ipv6 ospf network ')))
      .toEqual(['broadcast', 'non-broadcast', 'point-to-multipoint', 'point-to-point']);
    expect(await router.executeCommand('ipv6 ospf network zorglub'))
      .toContain('Invalid input');
  });

  it('a cost outside the range is refused where it was typed', async () => {
    const router = await onInterface();

    expect(await router.executeCommand('ipv6 ospf cost 0')).toContain('Invalid input');
    expect(await router.executeCommand('ipv6 ospf cost 50')).toBe('');
  });

  it('`no ipv6 ospf <id> area <n>` really removes the interface', async () => {
    const router = await onInterface();
    await router.executeCommand('ipv6 ospf 1 area 0');

    expect(await router.executeCommand('do show ipv6 ospf interface'))
      .toContain('GigabitEthernet0/0');

    await router.executeCommand('no ipv6 ospf 1 area 0');

    expect(await router.executeCommand('do show ipv6 ospf interface'))
      .not.toContain('GigabitEthernet0/0');
  });

  it('and `ipv6 ?` names the branch instead of borrowing a child\'s wording', async () => {
    const router = await onInterface();

    expect(router.cliHelp('ipv6 ')).toContain('OSPFv3 interface commands');
    expect(router.cliHelp('ipv6 ')).not.toContain('ospf            Set OSPFv3 cost');
  });
});

describe('une ambiguite qui traverse les DEUX moteurs reste une ambiguite', () => {
  async function privilegie(): Promise<Cli> {
    const router = new CiscoRouter(`R${serial++}`) as unknown as Cli;
    await router.executeCommand('enable');
    return router;
  }

  it('`show ip s` nomme l\'ambiguite bien que chaque moteur n\'en voie qu\'une part',
    async () => {
      const router = await privilegie();
      expect(await router.executeCommand('show ip s'))
        .toBe('% Ambiguous command:  "show ip s"');
    });

  it('un mot-cle TAPE EN ENTIER que le trie porte l\'emporte sur l\'ambiguite',
    async () => {
      const router = await privilegie();
      const rendu = await router.executeCommand('show ip route');
      expect(rendu).not.toContain('Ambiguous');
      expect(rendu).toContain('Codes:');
    });

  it('une abreviation que le socle SEUL resout s\'execute', async () => {
    const router = await privilegie();
    expect(await router.executeCommand('show ip ss')).not.toContain('Ambiguous');
  });
});
