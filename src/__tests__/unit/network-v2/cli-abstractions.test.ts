/**
 * Tests for CLI abstraction layer:
 *   - CLIStateMachine (exit/end FSM)
 *   - PromptBuilder (data-driven prompts)
 *   - cli-utils (pipe filter, error messages, interface resolution)
 *   - FlowSteps (shared flow step factories)
 */

import { describe, it, expect } from 'vitest';
import {
  CLIStateMachine,
  CISCO_IOS_MODES,
  CISCO_SWITCH_MODES,
  HUAWEI_VRP_MODES,
} from '@/network/devices/shells/CLIStateMachine';
import {
  buildPrompt,
  CISCO_IOS_PROMPTS,
  CISCO_SWITCH_PROMPTS,
  HUAWEI_VRP_PROMPTS,
} from '@/network/devices/shells/PromptBuilder';
import {
  parsePipeFilter,
  applyPipeFilter,
  CISCO_ERRORS,
  HUAWEI_ERRORS,
  resolveCiscoInterfaceName,
  resolveHuaweiInterfaceName,
} from '@/network/devices/shells/cli-utils';
import {
  password,
  enablePassword,
  sudoPassword,
  suPassword,
  currentPassword,
  newPasswordPair,
  confirmation,
  output,
  execute,
  branch,
  DEFAULT_MAX_PASSWORD_RETRIES,
  MAX_SUDO_ATTEMPTS,
} from '@/terminal/flows/FlowSteps';
import type { FlowContext } from '@/terminal/core/types';

// ═══════════════════════════════════════════════════════════════════
// CLIStateMachine Tests
// ═══════════════════════════════════════════════════════════════════

describe('CLIStateMachine', () => {
  describe('Cisco IOS mode hierarchy', () => {
    it('should start in user mode', () => {
      const fsm = new CLIStateMachine('user', CISCO_IOS_MODES, 'user', 'privileged');
      expect(fsm.mode).toBe('user');
    });

    it('exit from user should stay in user', () => {
      const fsm = new CLIStateMachine('user', CISCO_IOS_MODES, 'user', 'privileged');
      const result = fsm.exit();
      expect(result.newMode).toBe('user');
      expect(fsm.mode).toBe('user');
    });

    it('exit from privileged should go to user', () => {
      const fsm = new CLIStateMachine('privileged', CISCO_IOS_MODES, 'user', 'privileged');
      const result = fsm.exit();
      expect(result.newMode).toBe('user');
    });

    it('exit from config should go to privileged', () => {
      const fsm = new CLIStateMachine('config', CISCO_IOS_MODES, 'user', 'privileged');
      const result = fsm.exit();
      expect(result.newMode).toBe('privileged');
    });

    it('exit from config-if should go to config and clear selectedInterface', () => {
      const fsm = new CLIStateMachine('config-if', CISCO_IOS_MODES, 'user', 'privileged');
      const result = fsm.exit();
      expect(result.newMode).toBe('config');
      expect(result.fieldsToCllear).toContain('selectedInterface');
    });

    it('exit from config-ikev2-keyring-peer should go to config-ikev2-keyring', () => {
      const fsm = new CLIStateMachine('config-ikev2-keyring-peer', CISCO_IOS_MODES, 'user', 'privileged');
      const result = fsm.exit();
      expect(result.newMode).toBe('config-ikev2-keyring');
      expect(result.fieldsToCllear).toContain('selectedIKEv2KeyringPeer');
    });

    it('end from config-if should jump to privileged and clear fields', () => {
      const fsm = new CLIStateMachine('config-if', CISCO_IOS_MODES, 'user', 'privileged');
      const result = fsm.end();
      expect(result.newMode).toBe('privileged');
      expect(result.fieldsToCllear).toContain('selectedInterface');
    });

    it('end from deeply nested mode should jump to privileged', () => {
      const fsm = new CLIStateMachine('config-ikev2-keyring-peer', CISCO_IOS_MODES, 'user', 'privileged');
      const result = fsm.end();
      expect(result.newMode).toBe('privileged');
      expect(result.fieldsToCllear).toContain('selectedIKEv2KeyringPeer');
      expect(result.fieldsToCllear).toContain('selectedIKEv2Keyring');
    });

    it('end from user/privileged should be a no-op', () => {
      const fsm = new CLIStateMachine('privileged', CISCO_IOS_MODES, 'user', 'privileged');
      const result = fsm.end();
      expect(result.newMode).toBe('privileged');
      expect(result.fieldsToCllear).toHaveLength(0);
    });

    it('isConfigMode should be true for config modes', () => {
      const fsm = new CLIStateMachine('config', CISCO_IOS_MODES, 'user', 'privileged');
      expect(fsm.isConfigMode()).toBe(true);
    });

    it('isConfigMode should be false for user/privileged', () => {
      const fsm = new CLIStateMachine('user', CISCO_IOS_MODES, 'user', 'privileged');
      expect(fsm.isConfigMode()).toBe(false);
      fsm.mode = 'privileged';
      expect(fsm.isConfigMode()).toBe(false);
    });
  });

  describe('Cisco Switch mode hierarchy', () => {
    it('exit from config-vlan should go to config and clear selectedVlan', () => {
      const fsm = new CLIStateMachine('config-vlan', CISCO_SWITCH_MODES, 'user', 'privileged');
      const result = fsm.exit();
      expect(result.newMode).toBe('config');
      expect(result.fieldsToCllear).toContain('selectedVlan');
    });

    it('end from config-if should clear interface and range', () => {
      const fsm = new CLIStateMachine('config-if', CISCO_SWITCH_MODES, 'user', 'privileged');
      const result = fsm.end();
      expect(result.newMode).toBe('privileged');
      expect(result.fieldsToCllear).toContain('selectedInterface');
      expect(result.fieldsToCllear).toContain('selectedInterfaceRange');
    });
  });

  describe('Huawei VRP mode hierarchy', () => {
    it('exit from interface should go to system', () => {
      const fsm = new CLIStateMachine('interface', HUAWEI_VRP_MODES, 'user', 'user');
      const result = fsm.exit();
      expect(result.newMode).toBe('system');
      expect(result.fieldsToCllear).toContain('selectedInterface');
    });

    it('exit from ospf-area should go to ospf (nested)', () => {
      const fsm = new CLIStateMachine('ospf-area', HUAWEI_VRP_MODES, 'user', 'user');
      const result = fsm.exit();
      expect(result.newMode).toBe('ospf');
      expect(result.fieldsToCllear).toContain('ospfArea');
    });

    it('exit from system should go to user', () => {
      const fsm = new CLIStateMachine('system', HUAWEI_VRP_MODES, 'user', 'user');
      const result = fsm.exit();
      expect(result.newMode).toBe('user');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// PromptBuilder Tests
// ═══════════════════════════════════════════════════════════════════

describe('PromptBuilder', () => {
  it('should generate Cisco IOS prompts for all modes', () => {
    expect(buildPrompt('user', 'R1', CISCO_IOS_PROMPTS)).toBe('R1>');
    expect(buildPrompt('privileged', 'R1', CISCO_IOS_PROMPTS)).toBe('R1#');
    expect(buildPrompt('config', 'R1', CISCO_IOS_PROMPTS)).toBe('R1(config)#');
    expect(buildPrompt('config-if', 'R1', CISCO_IOS_PROMPTS)).toBe('R1(config-if)#');
    expect(buildPrompt('config-dhcp', 'R1', CISCO_IOS_PROMPTS)).toBe('R1(dhcp-config)#');
    expect(buildPrompt('config-router', 'R1', CISCO_IOS_PROMPTS)).toBe('R1(config-router)#');
    expect(buildPrompt('config-router-ospf', 'R1', CISCO_IOS_PROMPTS)).toBe('R1(config-router)#');
    expect(buildPrompt('config-router-ospfv3', 'R1', CISCO_IOS_PROMPTS)).toBe('R1(config-rtr)#');
  });

  it('should generate Cisco Switch prompts', () => {
    expect(buildPrompt('user', 'SW1', CISCO_SWITCH_PROMPTS)).toBe('SW1>');
    expect(buildPrompt('privileged', 'SW1', CISCO_SWITCH_PROMPTS)).toBe('SW1#');
    expect(buildPrompt('config', 'SW1', CISCO_SWITCH_PROMPTS)).toBe('SW1(config)#');
    expect(buildPrompt('config-vlan', 'SW1', CISCO_SWITCH_PROMPTS)).toBe('SW1(config-vlan)#');
  });

  it('should generate Huawei VRP prompts with dynamic fields', () => {
    expect(buildPrompt('user', 'AR1', HUAWEI_VRP_PROMPTS)).toBe('<AR1>');
    expect(buildPrompt('system', 'AR1', HUAWEI_VRP_PROMPTS)).toBe('[AR1]');
    expect(buildPrompt('interface', 'AR1', HUAWEI_VRP_PROMPTS, {
      selectedInterface: 'GE0/0/0',
    })).toBe('[AR1-GE0/0/0]');
    expect(buildPrompt('dhcp-pool', 'AR1', HUAWEI_VRP_PROMPTS, {
      selectedPool: 'pool1',
    })).toBe('[AR1-ip-pool-pool1]');
  });

  it('should use fallback for unknown mode', () => {
    expect(buildPrompt('unknown-mode', 'R1', CISCO_IOS_PROMPTS)).toBe('R1>');
  });
});

// ═══════════════════════════════════════════════════════════════════
// cli-utils Tests
// ═══════════════════════════════════════════════════════════════════

describe('cli-utils', () => {
  describe('parsePipeFilter', () => {
    it('should return cmd without filter when no pipe', () => {
      const result = parsePipeFilter('show ip route');
      expect(result.cmd).toBe('show ip route');
      expect(result.filter).toBeNull();
    });

    it('should parse include filter', () => {
      const result = parsePipeFilter('show ip route | include 10.0');
      expect(result.cmd).toBe('show ip route');
      expect(result.filter).toEqual({ type: 'include', pattern: '10.0' });
    });

    it('should parse exclude filter', () => {
      const result = parsePipeFilter('show running-config | exclude !');
      expect(result.cmd).toBe('show running-config');
      expect(result.filter).toEqual({ type: 'exclude', pattern: '!' });
    });

    it('should parse grep filter (case-insensitive)', () => {
      const result = parsePipeFilter('show log | GREP error');
      expect(result.filter).toEqual({ type: 'grep', pattern: 'error' });
    });

    it('should parse findstr filter', () => {
      const result = parsePipeFilter('show arp | findstr 192.168');
      expect(result.filter).toEqual({ type: 'findstr', pattern: '192.168' });
    });

    it('should handle invalid pipe filter gracefully', () => {
      const result = parsePipeFilter('show ip route | badfilter test');
      expect(result.filter).toBeNull();
    });
  });

  describe('applyPipeFilter', () => {
    const output = 'line1 alpha\nline2 beta\nline3 alpha beta\nline4 gamma';

    it('should return output unchanged when no filter', () => {
      expect(applyPipeFilter(output, null)).toBe(output);
    });

    it('should include matching lines', () => {
      const result = applyPipeFilter(output, { type: 'include', pattern: 'alpha' });
      expect(result).toBe('line1 alpha\nline3 alpha beta');
    });

    it('should exclude matching lines', () => {
      const result = applyPipeFilter(output, { type: 'exclude', pattern: 'alpha' });
      expect(result).toBe('line2 beta\nline4 gamma');
    });

    it('should be case-insensitive', () => {
      const result = applyPipeFilter(output, { type: 'include', pattern: 'ALPHA' });
      expect(result).toBe('line1 alpha\nline3 alpha beta');
    });

    it('should strip surrounding quotes from pattern', () => {
      const result = applyPipeFilter(output, { type: 'include', pattern: '"alpha"' });
      expect(result).toBe('line1 alpha\nline3 alpha beta');
    });

    it('should handle empty output', () => {
      expect(applyPipeFilter('', { type: 'include', pattern: 'test' })).toBe('');
    });
  });

  describe('CISCO_ERRORS', () => {
    it('should format error messages correctly', () => {
      expect(CISCO_ERRORS.AMBIGUOUS('show')).toBe('% Ambiguous command: "show"');
      expect(CISCO_ERRORS.INCOMPLETE).toBe('% Incomplete command.');
      expect(CISCO_ERRORS.INVALID_INPUT).toBe("% Invalid input detected at '^' marker.");
      expect(CISCO_ERRORS.UNRECOGNIZED('foo')).toBe('% Unrecognized command "foo"');
    });
  });

  describe('HUAWEI_ERRORS', () => {
    it('should format error messages correctly', () => {
      expect(HUAWEI_ERRORS.AMBIGUOUS('display')).toBe('Error: Ambiguous command "display"');
      expect(HUAWEI_ERRORS.INCOMPLETE).toBe('Error: Incomplete command.');
      expect(HUAWEI_ERRORS.UNRECOGNIZED('xyz')).toBe('Error: Unrecognized command "xyz"');
    });
  });

  describe('resolveCiscoInterfaceName', () => {
    const ports = ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Loopback0', 'Serial0/0/0'];

    it('should resolve direct match (case-insensitive)', () => {
      expect(resolveCiscoInterfaceName(ports, 'gigabitethernet0/0')).toBe('GigabitEthernet0/0');
    });

    it('should resolve gi abbreviation', () => {
      expect(resolveCiscoInterfaceName(ports, 'gi0/0')).toBe('GigabitEthernet0/0');
    });

    it('should resolve g abbreviation', () => {
      expect(resolveCiscoInterfaceName(ports, 'g0/1')).toBe('GigabitEthernet0/1');
    });

    it('should resolve lo abbreviation', () => {
      expect(resolveCiscoInterfaceName(ports, 'lo0')).toBe('Loopback0');
    });

    it('should resolve se abbreviation', () => {
      expect(resolveCiscoInterfaceName(ports, 'se0/0/0')).toBe('Serial0/0/0');
    });

    it('should return null for unknown interface', () => {
      expect(resolveCiscoInterfaceName(ports, 'FastEthernet0/0')).toBeNull();
    });
  });

  describe('resolveHuaweiInterfaceName', () => {
    const ports = ['GE0/0/0', 'GE0/0/1', 'GE0/0/2'];

    it('should resolve direct match', () => {
      expect(resolveHuaweiInterfaceName(ports, 'GE0/0/0')).toBe('GE0/0/0');
    });

    it('should resolve ge abbreviation', () => {
      expect(resolveHuaweiInterfaceName(ports, 'ge0/0/1')).toBe('GE0/0/1');
    });

    it('should return null for unknown interface', () => {
      expect(resolveHuaweiInterfaceName(ports, 'FastEthernet0/0')).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// FlowSteps Tests
// ═══════════════════════════════════════════════════════════════════

describe('FlowSteps', () => {
  const mockDevice = {
    checkPassword: (user: string, pwd: string) => user === 'admin' && pwd === 'secret',
    checkEnablePassword: (pwd: string) => pwd === 'enable123',
  } as any;

  const mockContext: FlowContext = {
    values: new Map(),
    device: mockDevice,
    currentUser: 'admin',
    currentUid: 0,
    metadata: new Map(),
  };

  describe('password()', () => {
    it('should create a password step with correct type', () => {
      const step = password({
        validator: () => true,
        errorMessage: 'Wrong!',
      });
      expect(step.type).toBe('password');
      expect(step.prompt).toBe('Password:');
      expect(step.storeAs).toBe('password');
    });

    it('should validate with custom validator', () => {
      const step = password({
        validator: (pwd) => pwd === 'correct',
        errorMessage: 'Bad password',
        maxRetries: 3,
      });
      const valid = step.validation!('correct', mockContext);
      expect(valid.valid).toBe(true);

      const invalid = step.validation!('wrong', mockContext);
      expect(invalid.valid).toBe(false);
      expect(invalid.errorMessage).toBe('Bad password');
      expect(invalid.maxRetries).toBe(3);
    });
  });

  describe('enablePassword()', () => {
    it('should create Cisco enable password step', () => {
      const step = enablePassword('% Bad secrets');
      expect(step.type).toBe('password');
      expect(step.storeAs).toBe('enable_password');

      const valid = step.validation!('enable123', mockContext);
      expect(valid.valid).toBe(true);

      const invalid = step.validation!('wrong', mockContext);
      expect(invalid.valid).toBe(false);
      expect(invalid.errorMessage).toBe('% Bad secrets');
      expect(invalid.maxRetries).toBe(DEFAULT_MAX_PASSWORD_RETRIES);
    });
  });

  describe('sudoPassword()', () => {
    it('should create sudo password step with correct retries', () => {
      const step = sudoPassword('admin');
      expect(step.type).toBe('password');
      expect(step.storeAs).toBe('sudo_password');

      const valid = step.validation!('secret', mockContext);
      expect(valid.valid).toBe(true);

      const invalid = step.validation!('wrong', mockContext);
      expect(invalid.valid).toBe(false);
      expect(invalid.errorMessage).toBe('Sorry, try again.');
      expect(invalid.maxRetries).toBe(MAX_SUDO_ATTEMPTS - 1);
    });
  });

  describe('suPassword()', () => {
    it('should create su password step for target user', () => {
      const step = suPassword('admin');
      const valid = step.validation!('secret', mockContext);
      expect(valid.valid).toBe(true);

      const invalid = step.validation!('wrong', mockContext);
      expect(invalid.errorMessage).toBe('su: Authentication failure');
    });
  });

  describe('currentPassword()', () => {
    it('should create current password step with zero retries', () => {
      const step = currentPassword();
      expect(step.storeAs).toBe('current_password');

      const invalid = step.validation!('wrong', mockContext);
      expect(invalid.maxRetries).toBe(0);
    });
  });

  describe('newPasswordPair()', () => {
    it('should create two steps for new + confirm', () => {
      const steps = newPasswordPair();
      expect(steps).toHaveLength(2);
      expect(steps[0].storeAs).toBe('new_password');
      expect(steps[1].storeAs).toBe('confirm_password');
    });

    it('should validate password match', () => {
      const steps = newPasswordPair();
      const ctx: FlowContext = {
        ...mockContext,
        values: new Map([['new_password', 'test123']]),
      };

      const match = steps[1].validation!('test123', ctx);
      expect(match.valid).toBe(true);

      const noMatch = steps[1].validation!('different', ctx);
      expect(noMatch.valid).toBe(false);
    });
  });

  describe('confirmation()', () => {
    it('should create confirmation step', () => {
      const step = confirmation({ prompt: 'Proceed? [confirm]' });
      expect(step.type).toBe('confirmation');
      expect(step.prompt).toBe('Proceed? [confirm]');
      expect(step.defaultAnswer).toBe('yes');
    });

    it('should create confirmation with cancel message', () => {
      const step = confirmation({
        prompt: 'Continue?',
        cancelMessage: 'Aborted.',
      });
      const result = step.validation!('no', mockContext);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBe('Aborted.');
    });
  });

  describe('output()', () => {
    it('should create output step', () => {
      const step = output(['line1', 'line2']);
      expect(step.type).toBe('output');
      expect(step.outputLines).toEqual(['line1', 'line2']);
    });
  });

  describe('execute()', () => {
    it('should create execute step', () => {
      const action = async () => {};
      const step = execute(action);
      expect(step.type).toBe('execute');
      expect(step.action).toBe(action);
    });
  });

  describe('branch()', () => {
    it('should create branch step', () => {
      const pred = () => 5;
      const step = branch(pred);
      expect(step.type).toBe('branch');
      expect(step.predicate).toBe(pred);
    });
  });
});
