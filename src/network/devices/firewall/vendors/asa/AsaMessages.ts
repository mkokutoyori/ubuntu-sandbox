export const ASA_INVALID_INPUT = '% Invalid input detected at \'^\' marker.';
export const ASA_INCOMPLETE = '% Incomplete command.';

export function asaSecurityLevelNotice(zoneName: string, level: number): string {
  return `INFO: Security level for "${zoneName}" set to ${level} by default.`;
}

export function asaNotImplemented(command: string, missing: string): string {
  return `% Feature '${command}' is not implemented in this simulator (${missing})`;
}

export const ASA_UNIMPLEMENTED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'show module': 'the simulated chassis is fixed-configuration',
  'verify /md5': 'no image content exists to hash',
  'threat-detection scanning-threat': 'no scanning-threat engine exists yet',
  'packet-capture': 'no capture buffer model exists yet',
  'inspect sip': 'no SIP protocol engine exists',
  'inspect h323': 'no H.323 protocol engine exists',
  'failover': 'high availability is not implemented yet',
});
