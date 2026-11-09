/*
 * Probe — Add-/Get-/Set-/Remove-DnsServerRecursionScope exist and the scopes really steer recursion: the default scope "." is the
 * legacy forwarders and the legacy recursion setting (one store, so Set-DnsServerRecursionScope -Name . and
 * Set-DnsServerForwarder or Set-DnsServerRecursion show each other's work), another scope carries its own forwarders and its own
 * flag, a recursion policy that ALLOWs names the scope its matches use, in the ratio of the weights it gives, and a scope that a
 * policy names cannot be removed. The examples of the Learn pages are the transcripts, the split-brain policy of example 7 of
 * Add-DnsServerQueryResolutionPolicy is the lab.
 *
 * Measured first (a Windows DNS server holding corp.test and forwarding to a second one that holds ext.test): none of the four
 * cmdlets existed ("is not recognized"), and a recursion policy could name no scope but ".".
 *
 * Authority: the Learn pages of the four cmdlets (parameter positions, the object printed as Name, Forwarder and EnableRecursion,
 * "the legacy recursion setting and list of forwarders are now referred as the default recursion scope. You cannot add or remove
 * the default recursion scope, identified by name as dot"), the class DnsServerRecursionScope (Name, Forwarder[], EnableRecursion),
 * the page of Add-DnsServerQueryResolutionPolicy ("if the action is ALLOW, the DNS server gets settings from the configured
 * recursion scope"), [MS-DNSP] DeleteServerScope (9959 when the scope is absent, 9988 when a policy names it) and
 * DNS_RPC_POLICY_CONTENT (the weights), and the Windows message table (9960 "The scope is the same as the default scope.", 9963
 * "The scope already exists."). Not sourced, said here: that a scope added without -EnableRecursion has recursion on, that a scope
 * with no forwarder resolves from the root hints, that adding or removing "." is refused with the text of 9960, that a scope
 * name is unique whatever its case, that the cache is shared by every scope (cache scopes come with the zone scopes), that
 * Remove asks its confirmation before it looks for the scope, and that the forwarders of a scope are IPv4 addresses like the
 * ones of Set-DnsServerForwarder.
 *
 * Discrimination (the probe run on the tree before the change): all 33 cases fall, none of the four cmdlets existed.
 */
import { describe, it, expect } from 'vitest';
import { RRType } from '@/network/dns/wire/RRType';
import { policyLab as governed, run } from './dnsRateLimitingLab';

const ADD = 'Add-DnsServerRecursionScope';
const GET = 'Get-DnsServerRecursionScope';
const SET = 'Set-DnsServerRecursionScope';
const REMOVE = 'Remove-DnsServerRecursionScope';
const POLICY = 'Add-DnsServerQueryResolutionPolicy';

const MISSING = 'The scope does not exist.';
const EXISTS = 'The scope already exists.';
const IS_DEFAULT = 'The scope is the same as the default scope.';
const REFERENCED = 'The server scope cannot be deleted because it is referenced by a DNS Policy.';
const NON_INTERACTIVE = 'PowerShell is in NonInteractive mode.';

const tidy = (text: string): string => text.split('\n').map(line => line.trimEnd()).join('\n');

async function steering() {
  const context = await governed();
  await context.cmd('Set-DnsServerForwarder -IPAddress 10.0.1.31 -UseRootHint $false');
  for (let index = 1; index <= 8; index++) {
    await run(context.master, `Add-DnsServerResourceRecordA -ZoneName ext.test -Name n${index} -IPv4Address 10.0.7.${20 + index}`);
  }
  return context;
}

describe('the cmdlets of the examples', () => {
  it('list the default scope alone on a new server: no forwarder, recursion on', async () => {
    const { cmd } = await governed();
    expect(tidy(await cmd(GET))).toBe([
      '',
      'Name Forwarder EnableRecursion',
      '---- --------- ---------------',
      '.              True',
      '',
    ].join('\n'));
  });

  it('add the scope of example 1 of Add and show it', async () => {
    const { cmd } = await governed();
    expect(tidy(await cmd(`${ADD} -Name "ScopeInternal" -Forwarder 10.0.0.1,172.22.0.1 -EnableRecursion $True -PassThru`))).toBe([
      '',
      'Name          Forwarder              EnableRecursion',
      '----          ---------              ---------------',
      'ScopeInternal {10.0.0.1, 172.22.0.1} True',
      '',
    ].join('\n'));
    expect(await cmd(`${ADD} -Name Quiet -Forwarder 10.0.0.1`)).toBe('');
  });

  it('list the default scope and the scopes added, and get one by name whatever its case or by position', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name "ScopeInternal" -Forwarder 10.0.0.1,172.22.0.1 -EnableRecursion $True`);
    expect(tidy(await cmd(GET))).toBe([
      '',
      'Name          Forwarder              EnableRecursion',
      '----          ---------              ---------------',
      '.                                    True',
      'ScopeInternal {10.0.0.1, 172.22.0.1} True',
      '',
    ].join('\n'));
    expect(await cmd(`(${GET} -Name scopeinternal).Name`)).toBe('ScopeInternal');
    expect(await cmd(`(${GET} SCOPEINTERNAL).Name`)).toBe('ScopeInternal');
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('.,ScopeInternal');
  });

  it('set the forwarder and the recursion of example 1 of Set', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name "ScopeInternal" -Forwarder 10.0.0.1,172.22.0.1 -EnableRecursion $True`);
    expect(tidy(await cmd(`${SET} -Name "ScopeInternal" -Forwarder 192.168.0.1 -EnableRecursion $False -PassThru`))).toBe([
      '',
      'Name          Forwarder     EnableRecursion',
      '----          ---------     ---------------',
      'ScopeInternal {192.168.0.1} False',
      '',
    ].join('\n'));
  });

  it('set only what is given: the forwarders alone, the flag alone', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name S -Forwarder 10.0.0.1 -EnableRecursion $False`);
    await cmd(`${SET} -Name S -Forwarder 10.0.0.2,10.0.0.3`);
    expect(await cmd(`(${GET} -Name S).Forwarder -join ","`)).toBe('10.0.0.2,10.0.0.3');
    expect(await cmd(`(${GET} -Name S).EnableRecursion`)).toBe('False');
    await cmd(`${SET} -Name S -EnableRecursion $True`);
    expect(await cmd(`(${GET} -Name S).Forwarder -join ","`)).toBe('10.0.0.2,10.0.0.3');
    expect(await cmd(`(${GET} -Name S).EnableRecursion`)).toBe('True');
  });

  it('add a scope with recursion on when -EnableRecursion is not given', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name S`);
    expect(await cmd(`(${GET} -Name S).EnableRecursion`)).toBe('True');
    expect(await cmd(`(${GET} -Name S).Forwarder`)).toBe('');
  });

  it('remove the scope of the example with -Force and -PassThru', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name "ScopeInternal" -Forwarder 10.0.0.1 -EnableRecursion $False`);
    expect(tidy(await cmd(`${REMOVE} -Name "ScopeInternal" -PassThru -Force`))).toBe([
      '',
      'Name          Forwarder  EnableRecursion',
      '----          ---------  ---------------',
      'ScopeInternal {10.0.0.1} False',
      '',
    ].join('\n'));
    expect(await cmd(`(${GET}).Name`)).toBe('.');
  });

  it('ask before they remove, whether or not the scope exists, and name their target under -WhatIf', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name S`);
    expect(await cmd(`${REMOVE} -Name S`)).toContain(`${REMOVE}: ${NON_INTERACTIVE}`);
    expect(await cmd(`${REMOVE} -Name Nope`)).toContain(`${REMOVE}: ${NON_INTERACTIVE}`);
    expect(await cmd(`${REMOVE} -Name Nope -Force`)).toContain(`${REMOVE}: ${MISSING}`);
    expect(await cmd(`${REMOVE} -Name S -WhatIf`)).toContain(`What if: Performing the operation "${REMOVE}" on target "S".`);
    expect(await cmd(`${ADD} -Name T -WhatIf`)).toContain(`What if: Performing the operation "${ADD}" on target "T".`);
    expect(await cmd(`${SET} -Name S -EnableRecursion $False -WhatIf`)).toContain(`What if: Performing the operation "${SET}" on target "S".`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('.,S');
    expect(await cmd(`(${GET} -Name S).EnableRecursion`)).toBe('True');
  });

  it('bind the positions of the pages: name, forwarder, recursion', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} Positional 10.0.0.1 $false`)).toBe('');
    expect(await cmd(`(${GET} Positional).Forwarder`)).toBe('10.0.0.1');
    expect(await cmd(`(${GET} Positional).EnableRecursion`)).toBe('False');
    expect(await cmd(`${SET} Positional 10.0.0.2 $true`)).toBe('');
    expect(await cmd(`(${GET} Positional).Forwarder`)).toBe('10.0.0.2');
    expect(await cmd(`(${GET} Positional).EnableRecursion`)).toBe('True');
  });
});

describe('the default scope is the legacy forwarders and the legacy recursion setting', () => {
  it('shows the forwarders of Set-DnsServerForwarder and the recursion of Set-DnsServerRecursion', async () => {
    const { cmd } = await governed();
    await cmd('Set-DnsServerForwarder -IPAddress 10.0.1.30,10.0.1.31 -UseRootHint $false');
    await cmd('Set-DnsServerRecursion -Enable $false');
    expect(await cmd(`(${GET} -Name .).Forwarder -join ","`)).toBe('10.0.1.30,10.0.1.31');
    expect(await cmd(`(${GET} -Name .).EnableRecursion`)).toBe('False');
  });

  it('sets the forwarders and the recursion that Get-DnsServerForwarder and Get-DnsServerRecursion show', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${SET} -Name . -Forwarder 10.0.1.32 -EnableRecursion $False`)).toBe('');
    expect(await cmd('(Get-DnsServerForwarder).IPAddress -join ","')).toBe('10.0.1.32');
    expect(await cmd('(Get-DnsServerRecursion).Enable')).toBe('False');
    expect(await cmd(`${SET} -Name . -EnableRecursion $True`)).toBe('');
    expect(await cmd('(Get-DnsServerRecursion).Enable')).toBe('True');
    expect(await cmd('(Get-DnsServerForwarder).IPAddress -join ","')).toBe('10.0.1.32');
  });

  it('is told apart from the other scopes by its name alone', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Other -Forwarder 10.0.0.9 -EnableRecursion $False`);
    await cmd(`${SET} -Name Other -Forwarder 10.0.0.8`);
    expect(await cmd(`(${GET} -Name Other).Forwarder`)).toBe('10.0.0.8');
    expect(await cmd('(Get-DnsServerForwarder).IPAddress -join ","')).toBe('');
    expect(await cmd('(Get-DnsServerRecursion).Enable')).toBe('True');
  });
});

describe('the refusals', () => {
  it.each([
    ['a name that is taken, whatever its case', `${ADD} -Name TAKEN`, ADD, EXISTS],
    ['the default scope, to add', `${ADD} -Name .`, ADD, IS_DEFAULT],
    ['the default scope, to remove', `${REMOVE} -Name . -Force`, REMOVE, IS_DEFAULT],
    ['a scope that is not held, to get', `${GET} -Name Nope`, GET, MISSING],
    ['a scope that is not held, to set', `${SET} -Name Nope -EnableRecursion $true`, SET, MISSING],
    ['a scope that is not held, to remove', `${REMOVE} -Name Nope -Force`, REMOVE, MISSING],
    ['a forwarder that is no address, to add', `${ADD} -Name Bad -Forwarder 10.0.0.999`, ADD, '"10.0.0.999" is not a valid IPv4 address.'],
    ['a forwarder that is no address, to set', `${SET} -Name Taken -Forwarder host`, SET, '"host" is not a valid IPv4 address.'],
    ['a forwarder that is no address, to set on the default scope', `${SET} -Name . -Forwarder host`, SET, '"host" is not a valid IPv4 address.'],
  ])('refuse %s with the text of the Win32 error and change nothing', async (_label, command, cmdlet, message) => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Taken -Forwarder 10.0.0.1`);
    expect(await cmd(command)).toContain(`${cmdlet}: ${message}`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('.,Taken');
    expect(await cmd(`(${GET} -Name Taken).Forwarder`)).toBe('10.0.0.1');
    expect(await cmd('(Get-DnsServerForwarder).IPAddress -join ","')).toBe('');
  });

  it('refuse a call with no name', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -Forwarder 10.0.0.1`)).toContain('missing mandatory parameters: Name');
    expect(await cmd(`${SET} -EnableRecursion $true`)).toContain('missing mandatory parameters: Name');
    expect(await cmd(`${REMOVE} -Force`)).toContain('missing mandatory parameters: Name');
  });
});

describe('the policies name the scopes', () => {
  it('accept a recursion scope that exists, whatever its case, and refuse one that does not', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name InternalClients`);
    expect(await cmd(`${POLICY} -Name Missing -Action ALLOW -ApplyOnRecursion -RecursionScope "Nope" -ClientSubnet "EQ,Lan"`)).toContain(`${POLICY}: ${MISSING}`);
    expect(await cmd(`${POLICY} -Name Split -Action ALLOW -ApplyOnRecursion -RecursionScope "internalclients" -ClientSubnet "EQ,Lan"`)).toBe('');
    expect(await cmd('(Get-DnsServerQueryResolutionPolicy -Name Split).Content | ForEach-Object { $_.ScopeName }')).toBe('internalclients');
  });

  it('keep a scope from being removed while they name it, whatever the case, and let it go once they do not', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name InternalClients`);
    await cmd(`${POLICY} -Name Split -Action ALLOW -ApplyOnRecursion -RecursionScope "INTERNALCLIENTS" -ClientSubnet "EQ,Lan"`);
    expect(await cmd(`${REMOVE} -Name InternalClients -Force`)).toContain(`${REMOVE}: ${REFERENCED}`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('.,InternalClients');
    await cmd('Remove-DnsServerQueryResolutionPolicy -Name Split -Force');
    expect(await cmd(`${REMOVE} -Name InternalClients -Force`)).toBe('');
  });

  it('keep a scope from being removed while a policy names it among several', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A`);
    await cmd(`${ADD} -Name B`);
    await cmd(`${POLICY} -Name Split -Action ALLOW -ApplyOnRecursion -RecursionScope "A,2;B,1" -ClientSubnet "EQ,Lan"`);
    expect(await cmd(`${REMOVE} -Name B -Force`)).toContain(`${REMOVE}: ${REFERENCED}`);
    expect(await cmd(`${REMOVE} -Name A -Force`)).toContain(`${REMOVE}: ${REFERENCED}`);
  });

  it('let a scope go that a policy of another kind does not name', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A`);
    await cmd(`${POLICY} -Name Deny -Action DENY -ApplyOnRecursion -ClientSubnet "EQ,Lan"`);
    expect(await cmd(`${REMOVE} -Name A -Force`)).toBe('');
  });
});

describe('the scopes steer recursion, as the split-brain policy of example 7 of Add does', () => {
  it('resolve nothing while no policy names a scope and the default scope does not recurse', async () => {
    const { cmd, verdict, clientA } = await steering();
    await cmd(`${ADD} -Name InternalClients -Forwarder 10.0.1.30 -EnableRecursion $True`);
    await cmd(`${SET} -Name . -EnableRecursion $False`);
    expect(await verdict(clientA, 'host.ext.test')).toBe('refused');
  });

  it('send the clients a policy allows through the scope of the policy and refuse the others', async () => {
    const { cmd, verdict, clientA, clientC } = await steering();
    await cmd(`${ADD} -Name InternalClients -Forwarder 10.0.1.30 -EnableRecursion $True`);
    await cmd(`${SET} -Name . -EnableRecursion $False`);
    await cmd(`${POLICY} -Name SplitBrainPolicy -Action ALLOW -ApplyOnRecursion -RecursionScope "InternalClients" -ClientSubnet "EQ,Lan"`);
    expect([await verdict(clientA, 'n1.ext.test'), await verdict(clientC, 'n2.ext.test')]).toEqual(['answered', 'refused']);
  });

  it('use the forwarders of the scope and not the ones of the default scope', async () => {
    const { cmd, verdict, clientA, clientC } = await steering();
    await cmd(`${ADD} -Name InternalClients -Forwarder 10.0.1.30 -EnableRecursion $True`);
    await cmd(`${POLICY} -Name SplitBrainPolicy -Action ALLOW -ApplyOnRecursion -RecursionScope "InternalClients" -ClientSubnet "EQ,Lan"`);
    expect(await verdict(clientA, 'n1.ext.test')).toBe('answered');
    expect(await verdict(clientC, 'n2.ext.test')).not.toBe('answered');
    await cmd(`${SET} -Name InternalClients -Forwarder 10.0.1.31`);
    expect(await verdict(clientA, 'n3.ext.test')).not.toBe('answered');
  });

  it('refuse the clients of a scope that does not recurse', async () => {
    const { cmd, verdict, clientA } = await steering();
    await cmd(`${ADD} -Name InternalClients -Forwarder 10.0.1.30 -EnableRecursion $False`);
    await cmd(`${POLICY} -Name SplitBrainPolicy -Action ALLOW -ApplyOnRecursion -RecursionScope "InternalClients" -ClientSubnet "EQ,Lan"`);
    expect(await verdict(clientA, 'n1.ext.test')).toBe('refused');
    await cmd(`${SET} -Name InternalClients -EnableRecursion $True`);
    expect(await verdict(clientA, 'n2.ext.test')).toBe('answered');
  });

  it('spread the matches of a policy over its scopes in the ratio of the weights', async () => {
    const { cmd, verdict, clientA } = await steering();
    await cmd(`${ADD} -Name On -Forwarder 10.0.1.30 -EnableRecursion $True`);
    await cmd(`${ADD} -Name Off -Forwarder 10.0.1.30 -EnableRecursion $False`);
    await cmd(`${POLICY} -Name Ratio -Action ALLOW -ApplyOnRecursion -RecursionScope "On,2;Off,1" -ClientSubnet "EQ,Lan"`);
    const seen = [];
    for (let index = 1; index <= 6; index++) seen.push(await verdict(clientA, `n${index}.ext.test`));
    expect(seen).toEqual(['answered', 'answered', 'refused', 'answered', 'answered', 'refused']);
  });

  it('go back to the default scope once the policy is removed', async () => {
    const { cmd, verdict, clientA } = await steering();
    await cmd(`${ADD} -Name InternalClients -Forwarder 10.0.1.30 -EnableRecursion $True`);
    await cmd(`${POLICY} -Name SplitBrainPolicy -Action ALLOW -ApplyOnRecursion -RecursionScope "InternalClients" -ClientSubnet "EQ,Lan"`);
    expect(await verdict(clientA, 'n1.ext.test')).toBe('answered');
    await cmd('Remove-DnsServerQueryResolutionPolicy -Name SplitBrainPolicy -Force');
    expect(await verdict(clientA, 'n2.ext.test')).not.toBe('answered');
  });

  it('keep serving a name from the cache whatever the scope, as the cache is shared', async () => {
    const { cmd, verdict, clientA } = await steering();
    await cmd(`${ADD} -Name InternalClients -Forwarder 10.0.1.30 -EnableRecursion $True`);
    await cmd(`${POLICY} -Name SplitBrainPolicy -Action ALLOW -ApplyOnRecursion -RecursionScope "InternalClients" -ClientSubnet "EQ,Lan"`);
    expect(await verdict(clientA, 'n1.ext.test', RRType.A)).toBe('answered');
    await cmd('Remove-DnsServerQueryResolutionPolicy -Name SplitBrainPolicy -Force');
    expect(await verdict(clientA, 'n1.ext.test', RRType.A)).toBe('answered');
  });
});
