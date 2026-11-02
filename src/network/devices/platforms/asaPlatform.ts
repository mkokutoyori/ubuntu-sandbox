import { registerDeviceBuilder } from '../deviceBuilders';
import { AsaFirewall } from '../firewall/vendors/asa/AsaFirewall';

registerDeviceBuilder('firewall-cisco', (name, x, y) => new AsaFirewall('firewall-cisco', name, x, y));
