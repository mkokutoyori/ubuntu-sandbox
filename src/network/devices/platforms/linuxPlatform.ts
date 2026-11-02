import { registerDeviceBuilder } from '../deviceBuilders';
import { LinuxPC } from '../LinuxPC';
import { LinuxServer } from '../LinuxServer';

registerDeviceBuilder('linux-pc', (name, x, y) => new LinuxPC('linux-pc', name, x, y));
registerDeviceBuilder('mac-pc', (name, x, y) => new LinuxPC('mac-pc', name, x, y));
registerDeviceBuilder('linux-server', (name, x, y) => new LinuxServer('linux-server', name, x, y));
registerDeviceBuilder('firewall-paloalto', (name, x, y) => new LinuxPC('firewall-paloalto', name, x, y));
registerDeviceBuilder('cloud', (name, x, y) => new LinuxPC('cloud', name, x, y));
