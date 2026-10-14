import type { CommandSpec } from '@/cli/CommandTable';
import type { CiscoSecurityConfig } from '../../router/security/CiscoSecurityConfig';

export interface RadiusAttributeHost {
  security(): CiscoSecurityConfig;
}

const CONFIG = Object.freeze(['config']);

export function radiusAttributeSpecs(host: () => RadiusAttributeHost): CommandSpec[] {
  const settings = () => host().security().radiusAttributes;
  const flag = (
    id: string, path: string[], field: 'serviceTypeInLoginRequest' | 'serviceTypeMandatory' | 'serviceTypeSupportMultiple' | 'eventTimestampInAccounting',
    description: string, undoDescription: string,
  ): CommandSpec => ({
    id, path: ['radius-server', 'attribute', ...path], description, undoDescription,
    modes: CONFIG, minPrivilege: 15,
    run: () => { settings()[field] = true; return ''; },
    undo: () => { settings()[field] = false; return ''; },
  });
  return [
    {
      id: 'radius-server-attribute-4',
      path: ['radius-server', 'attribute', '4', { name: 'address', type: 'IP_ADDR', description: 'NAS-IP-Address to send' }],
      description: 'Set the address sent as RADIUS attribute 4',
      undoDescription: 'Send the address of the interface facing the server',
      modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => { settings().nasIpAddress = args.address; return ''; },
      undo: () => { settings().nasIpAddress = null; return ''; },
      undoOmitsArguments: true,
    },
    flag('radius-server-attribute-6-login', ['6', 'on-for-login-auth'], 'serviceTypeInLoginRequest',
      'Send Service-Type in login authentication requests', 'Stop sending Service-Type in login authentication requests'),
    flag('radius-server-attribute-6-mandatory', ['6', 'mandatory'], 'serviceTypeMandatory',
      'Require Service-Type in Access-Accept', 'Make Service-Type optional in Access-Accept'),
    flag('radius-server-attribute-6-multiple', ['6', 'support-multiple'], 'serviceTypeSupportMultiple',
      'Accept several Service-Type attributes in Access-Accept', 'Refuse several Service-Type attributes in Access-Accept'),
    {
      id: 'radius-server-attribute-32',
      path: ['radius-server', 'attribute', '32', 'include-in-access-req'],
      description: 'Send RADIUS attribute 32 (NAS-Identifier) in access and accounting requests',
      undoDescription: 'Stop sending RADIUS attribute 32',
      modes: CONFIG, minPrivilege: 15,
      run: () => { settings().nasIdentifier = { format: null }; return ''; },
      undo: () => { settings().nasIdentifier = null; return ''; },
    },
    {
      id: 'radius-server-attribute-32-format',
      path: ['radius-server', 'attribute', '32', 'include-in-access-req', 'format', { name: 'format', type: 'REST', description: 'String with %i (address), %h (hostname) and %d (domain name)' }],
      description: 'Send RADIUS attribute 32 built from a format string',
      modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => { settings().nasIdentifier = { format: args.format }; return ''; },
    },
    flag('radius-server-attribute-55', ['55', 'include-in-acct-req'], 'eventTimestampInAccounting',
      'Send RADIUS attribute 55 (Event-Timestamp) in accounting requests', 'Stop sending RADIUS attribute 55'),
  ];
}
