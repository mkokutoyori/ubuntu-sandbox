export interface NetshLocalState {
  winhttpProxy: string;
  wlanConnectedSSID: string;
  wlanProfiles: Set<string>;
}

export function handleNetshWinhttp(ns: NetshLocalState, args: string[]): string {
    const sub = args[0]?.toLowerCase() ?? '';
    const rest = args.slice(1).map(a => a.toLowerCase());

    if (sub === 'show' && rest[0] === 'proxy') {
      if (!ns.winhttpProxy) {
        return 'Current WinHTTP proxy settings:\n\n    Direct access (no proxy server).';
      }
      return `Current WinHTTP proxy settings:\n\n    Proxy Server(s) :  ${ns.winhttpProxy}\n    Bypass List     :  (none)`;
    }

    if (sub === 'set' && rest[0] === 'proxy') {
      const proxyArg = args[2]?.replace(/^["']|["']$/g, '') ?? '';
      if (!proxyArg) return 'Usage: netsh winhttp set proxy <proxy-server> [<bypass-list>]';
      ns.winhttpProxy = proxyArg;
      return `Current WinHTTP proxy settings:\n\n    Proxy Server(s) :  ${ns.winhttpProxy}\n    Bypass List     :  (none)`;
    }

    if (sub === 'reset' && rest[0] === 'proxy') {
      ns.winhttpProxy = '';
      return 'Current WinHTTP proxy settings:\n\n    Direct access (no proxy server).';
    }

    if (sub === 'import' && rest[0] === 'proxy') {
      return 'Current WinHTTP proxy settings are set to match those of Internet Explorer.\n(Direct access - no proxy server.)';
    }

    return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\nimport         - Imports WinHTTP proxy settings.\nreset          - Resets WinHTTP settings.\nset            - Configures WinHTTP settings.\nshow           - Displays current settings.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
  }

export function handleNetshWlan(ns: NetshLocalState, args: string[]): string {
    const sub = args[0]?.toLowerCase() ?? '';
    const arg1 = args[1]?.toLowerCase() ?? '';

    // show profiles
    if (sub === 'show' && arg1 === 'profiles') {
      const profileFilter = args.slice(2).join(' ').match(/name="?([^"]+)"?/i)?.[1];
      if (profileFilter) {
        const key = profileFilter.toLowerCase();
        const name = [...ns.wlanProfiles].find(p => p.toLowerCase() === key);
        if (!name) return `There is no profile "name" to show on this interface.`;
        return `Profile ${name} on interface Wi-Fi:\n=======================================================================\n\nProfile information\n-------------------\n    Applied:                All User Profile\n    Profile name            : ${name}\n    SSID name               : "${name}"\n    Connection mode         : Connect automatically\n    Network broadcast       : Connect only if this network is broadcasting\n`;
      }
      if (ns.wlanProfiles.size === 0) {
        return `Profiles on interface Wi-Fi:\n\nUser profiles\n-------------\n    <None>\n`;
      }
      const profileLines = [...ns.wlanProfiles].map(p => `    All User Profile     : ${p}`).join('\n');
      return `Profiles on interface Wi-Fi:\n\nUser profiles\n-------------\n${profileLines}\n`;
    }

    // show interfaces
    if (sub === 'show' && arg1 === 'interfaces') {
      const state = ns.wlanConnectedSSID ? 'Connected' : 'Disconnected';
      const ssidLine = ns.wlanConnectedSSID ? `    SSID                   : ${ns.wlanConnectedSSID}\n` : '';
      return `There is 1 interface on the system:\n\n    Name                   : Wi-Fi\n    Description            : Intel(R) Wi-Fi 6 AX201\n    GUID                   : b1234567-89ab-cdef-0123-456789abcdef\n    Physical address       : 00:11:22:33:44:55\n    State                  : ${state}\n${ssidLine}    Radio status           : Hardware On\n                             Software On\n`;
    }

    // show networks
    if (sub === 'show' && arg1 === 'networks') {
      return `Interface name : Wi-Fi\nThere are 2 networks currently visible.\n\nSSID 1 : HomeNetwork\n    Network type            : Infrastructure\n    Authentication          : WPA2-Personal\n    Encryption              : CCMP\n\nSSID 2 : OfficeNet\n    Network type            : Infrastructure\n    Authentication          : WPA2-Personal\n    Encryption              : CCMP\n`;
    }

    // add profile
    if (sub === 'add' && arg1 === 'profile') {
      const nameArg = args.slice(2).join(' ').match(/name="?([^"]+)"?/i)?.[1];
      if (nameArg) {
        ns.wlanProfiles.add(nameArg);
        return `Profile ${nameArg} is added on interface Wi-Fi.`;
      }
      return 'Usage: netsh wlan add profile name="<profile-name>"';
    }

    // delete profile
    if (sub === 'delete' && arg1 === 'profile') {
      const nameArg = args.slice(2).join(' ').match(/name="?([^"]+)"?/i)?.[1];
      if (nameArg) {
        ns.wlanProfiles.delete(nameArg);
        if (ns.wlanConnectedSSID.toLowerCase() === nameArg.toLowerCase()) {
          ns.wlanConnectedSSID = '';
        }
        return `Profile "${nameArg}" is deleted from interface Wi-Fi.`;
      }
      return 'Usage: netsh wlan delete profile name="<profile-name>"';
    }

    // connect
    if (sub === 'connect') {
      const nameArg = args.slice(1).join(' ').match(/name="?([^"]+)"?/i)?.[1];
      if (nameArg) {
        ns.wlanConnectedSSID = nameArg;
        ns.wlanProfiles.add(nameArg);
        return `Connection request was completed successfully.`;
      }
      return 'Usage: netsh wlan connect name="<profile-name>"';
    }

    // disconnect
    if (sub === 'disconnect') {
      ns.wlanConnectedSSID = '';
      return 'Disconnection request was completed successfully.';
    }

    return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\ndump           - Displays a configuration script.\nhelp           - Displays a list of commands.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
  }
