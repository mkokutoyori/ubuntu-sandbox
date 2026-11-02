import { registerDeviceBuilder } from '../deviceBuilders';
import { FortiGate } from '../firewall/vendors/fortios/FortiGate';

registerDeviceBuilder('firewall-fortinet', (name, x, y) => new FortiGate('firewall-fortinet', name, x, y));
