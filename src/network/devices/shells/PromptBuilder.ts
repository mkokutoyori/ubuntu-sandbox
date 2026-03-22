/**
 * PromptBuilder — Data-driven prompt generation strategy.
 *
 * Eliminates duplicated switch-on-mode prompt logic across
 * CiscoIOSShell, CiscoSwitchShell, and HuaweiVRPShell.
 *
 * Each vendor defines a PromptMap that maps mode → prompt template.
 * Templates use `{host}` for hostname and `{field}` for dynamic values.
 */

// ─── Prompt Template ──────────────────────────────────────────────

export type PromptTemplate = string | ((hostname: string, fields: Record<string, string | null>) => string);

export type PromptMap = Record<string, PromptTemplate>;

/**
 * Build a CLI prompt from a mode and hostname using a PromptMap.
 *
 * @param mode      Current CLI mode
 * @param hostname  Device hostname
 * @param promptMap Mode → prompt template mapping
 * @param fields    Dynamic field values for interpolation (selectedInterface, etc.)
 * @param fallback  Fallback prompt if mode not found
 */
export function buildPrompt(
  mode: string,
  hostname: string,
  promptMap: PromptMap,
  fields?: Record<string, string | null>,
  fallback?: string,
): string {
  const template = promptMap[mode];
  if (!template) return fallback ?? `${hostname}>`;

  if (typeof template === 'function') {
    return template(hostname, fields ?? {});
  }

  // Simple string interpolation: replace {host} and {fieldName}
  let result = template.replace('{host}', hostname);
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      result = result.replace(`{${key}}`, value ?? '');
    }
  }
  return result;
}

// ─── Cisco IOS Prompt Map ─────────────────────────────────────────

export const CISCO_IOS_PROMPTS: PromptMap = {
  'user':                      '{host}>',
  'privileged':                '{host}#',
  'config':                    '{host}(config)#',
  'config-if':                 '{host}(config-if)#',
  'config-dhcp':               '{host}(dhcp-config)#',
  'config-router':             '{host}(config-router)#',
  'config-router-ospf':        '{host}(config-router)#',
  'config-router-ospfv3':      '{host}(config-rtr)#',
  'config-std-nacl':           '{host}(config-std-nacl)#',
  'config-ext-nacl':           '{host}(config-ext-nacl)#',
  'config-ipv6-nacl':          '{host}(config-ipv6-nacl)#',
  'config-isakmp':             '{host}(config-isakmp)#',
  'config-tfset':              '{host}(cfg-crypto-trans)#',
  'config-crypto-map':         '{host}(config-crypto-map)#',
  'config-ipsec-profile':      '{host}(ipsec-profile)#',
  'config-ikev2-proposal':     '{host}(config-ikev2-proposal)#',
  'config-ikev2-policy':       '{host}(config-ikev2-policy)#',
  'config-ikev2-keyring':      '{host}(config-ikev2-keyring)#',
  'config-ikev2-keyring-peer': '{host}(config-ikev2-keyring-peer)#',
  'config-ikev2-profile':      '{host}(config-ikev2-profile)#',
};

// ─── Cisco Switch Prompt Map ──────────────────────────────────────

export const CISCO_SWITCH_PROMPTS: PromptMap = {
  'user':        '{host}>',
  'privileged':  '{host}#',
  'config':      '{host}(config)#',
  'config-if':   '{host}(config-if)#',
  'config-vlan': '{host}(config-vlan)#',
};

// ─── Huawei VRP Prompt Map ────────────────────────────────────────

export const HUAWEI_VRP_PROMPTS: PromptMap = {
  'user':            '<{host}>',
  'system':          '[{host}]',
  'interface':       (host, f) => `[${host}-${f.selectedInterface ?? ''}]`,
  'dhcp-pool':       (host, f) => `[${host}-ip-pool-${f.selectedPool ?? ''}]`,
  'ospf':            (host) => `[${host}-ospf-1]`,
  'ospf-area':       (host, f) => `[${host}-ospf-1-area-${f.ospfArea ?? ''}]`,
  'ike-proposal':    (host, f) => `[${host}-ike-proposal-${f.selectedIKEProposal ?? ''}]`,
  'ike-peer':        (host, f) => `[${host}-ike-peer-${f.selectedIKEPeer ?? ''}]`,
  'ipsec-proposal':  (host, f) => `[${host}-ipsec-proposal-${f.selectedIPSecProposal ?? ''}]`,
  'ipsec-policy':    (host, f) => `[${host}-ipsec-policy-${f.selectedIPSecPolicy ?? ''}-${f.selectedIPSecPolicySeq ?? ''}]`,
};
