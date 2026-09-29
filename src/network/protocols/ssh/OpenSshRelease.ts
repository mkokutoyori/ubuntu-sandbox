import { OPENSSH_UBUNTU_CLIENT_VERSION, OPENSSH_WINDOWS_CLIENT_VERSION } from './serverIdentification';

export interface OpenSshRelease {
  readonly clientVersion: string;
  readonly sshUsage: string;
  readonly keygenUsage: string;
  readonly addUsage: string;
  readonly addOptstring: string;
}

const ADD_USAGE_TAIL = [
  '               [file ...]',
  '       ssh-add -s pkcs11',
  '       ssh-add -e pkcs11',
  '       ssh-add -T pubkey ...',
];

const SSH_USAGE_HEAD = [
  'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]',
  '           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]',
  '           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]',
  '           [-i identity_file] [-J [user@]host[:port]] [-L address]',
  '           [-l login_name] [-m mac_spec] [-O ctl_cmd] [-o option] [-p port]',
  '           [-Q query_option] [-R address] [-S ctl_path] [-W host:port]',
];

const KEYGEN_USAGE_HEAD = [
  'usage: ssh-keygen [-q] [-a rounds] [-b bits] [-C comment] [-f output_keyfile]',
  '                  [-m format] [-N new_passphrase] [-O option]',
  '                  [-t dsa | ecdsa | ecdsa-sk | ed25519 | ed25519-sk | rsa]',
  '                  [-w provider] [-Z cipher]',
  '       ssh-keygen -p [-a rounds] [-f keyfile] [-m format] [-N new_passphrase]',
  '                   [-P old_passphrase] [-Z cipher]',
  '       ssh-keygen -i [-f input_keyfile] [-m key_format]',
  '       ssh-keygen -e [-f input_keyfile] [-m key_format]',
  '       ssh-keygen -y [-f input_keyfile]',
  '       ssh-keygen -c [-a rounds] [-C comment] [-f keyfile] [-P passphrase]',
  '       ssh-keygen -l [-v] [-E fingerprint_hash] [-f input_keyfile]',
  '       ssh-keygen -B [-f input_keyfile]',
  '       ssh-keygen -D pkcs11',
  '       ssh-keygen -F hostname [-lv] [-f known_hosts_file]',
  '       ssh-keygen -H [-f known_hosts_file]',
  '       ssh-keygen -K [-a rounds] [-w provider]',
  '       ssh-keygen -R hostname [-f known_hosts_file]',
  '       ssh-keygen -r hostname [-g] [-f input_keyfile]',
  '       ssh-keygen -M generate [-O option] output_file',
  '       ssh-keygen -M screen [-f input_file] [-O option] output_file',
  '       ssh-keygen -I certificate_identity -s ca_key [-hU] [-D pkcs11_provider]',
  '                  [-n principals] [-O option] [-V validity_interval]',
  '                  [-z serial_number] file ...',
  '       ssh-keygen -L [-f input_keyfile]',
  '       ssh-keygen -A [-a rounds] [-f prefix_path]',
  '       ssh-keygen -k -f krl_file [-u] [-s ca_public] [-z version_number]',
  '                  file ...',
  '       ssh-keygen -Q [-l] -f krl_file [file ...]',
  '       ssh-keygen -Y find-principals -s signature_file -f allowed_signers_file',
];

export const OPENSSH_UBUNTU_22_04: OpenSshRelease = {
  clientVersion: OPENSSH_UBUNTU_CLIENT_VERSION,
  sshUsage: [
    ...SSH_USAGE_HEAD,
    '           [-w local_tun[:remote_tun]] destination [command [argument ...]]',
  ].join('\n'),
  keygenUsage: [
    ...KEYGEN_USAGE_HEAD,
    '       ssh-keygen -Y match-principals -I signer_identity -f allowed_signers_file',
    '       ssh-keygen -Y check-novalidate -n namespace -s signature_file',
    '       ssh-keygen -Y sign -f key_file -n namespace file [-O option] ...',
    '       ssh-keygen -Y verify -f allowed_signers_file -I signer_identity',
    '                  -n namespace -s signature_file [-r krl_file] [-O option]',
  ].join('\n'),
  addUsage: [
    'usage: ssh-add [-cDdKkLlqvXx] [-E fingerprint_hash] [-H hostkey_file]',
    '               [-h destination_constraint] [-S provider] [-t life]',
    ...ADD_USAGE_TAIL,
  ].join('\n'),
  addOptstring: '+vkKlLcdDTxXE:e:h:H:M:m:qs:S:t:',
};

export const OPENSSH_WINDOWS_8_6: OpenSshRelease = {
  clientVersion: OPENSSH_WINDOWS_CLIENT_VERSION,
  sshUsage: [
    ...SSH_USAGE_HEAD,
    '           [-w local_tun[:remote_tun]] destination [command]',
  ].join('\n'),
  keygenUsage: [
    ...KEYGEN_USAGE_HEAD,
    '       ssh-keygen -Y check-novalidate -n namespace -s signature_file',
    '       ssh-keygen -Y sign -f key_file -n namespace file ...',
    '       ssh-keygen -Y verify -f allowed_signers_file -I signer_identity',
    '                  -n namespace -s signature_file [-r revocation_file]',
  ].join('\n'),
  addUsage: [
    'usage: ssh-add [-cDdKkLlqvXx] [-E fingerprint_hash] [-S provider] [-t life]',
    ...ADD_USAGE_TAIL,
  ].join('\n'),
  addOptstring: '+vkKlLcdDTxXE:e:M:m:qs:S:t:',
};
