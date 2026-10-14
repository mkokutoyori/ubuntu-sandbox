#!/usr/bin/env python3
"""Generate the attribute specs of FortiOS tables from the CLI Reference text.

usage: generate_reference_attributes.py SCHEMA_DUMP.json OUT_DIR

Reads official_docs/forti-cli-ref-767.txt (syntax block and parameter table of
`config firewall policy|vip|address`) and writes one TypeScript module per
table with the attributes the hand-written schema does not declare yet. An
attribute listed in EVALUATED is declared plain; every other one carries
`unimplemented` with the reason of its family, so the CLI knows its grammar
(type, range, default, options) and refuses it rather than storing a setting
nothing enforces. Moving an attribute from refused to evaluated is a change to
EVALUATED and to the commit handler that consumes it.
"""
import json, re, sys, os, collections
sys.path.insert(0, os.path.dirname(__file__))
from parse_reference import parse_toplevel, detail

TABLES = {
    'firewall policy': ('firewallPolicyReference', 'POLICY_REFERENCE_ATTRIBUTES'),
    'firewall vip': ('firewallVipReference', 'VIP_REFERENCE_ATTRIBUTES'),
    'firewall address': ('firewallAddressReference', 'ADDRESS_REFERENCE_ATTRIBUTES'),
}

EVALUATED = json.load(open(os.path.join(os.path.dirname(__file__), 'evaluated.json')))

OVERRIDES = {
    'app-monitor': dict(type='option', options=[('enable', 'Enable TCP metrics in session logs.'), ('disable', 'Disable TCP metrics in session logs.')], default='disable'),
    'diffserv-reverse': dict(type='option', options=[('enable', 'Enable setting reverse (reply) traffic DiffServ.'), ('disable', 'Disable setting reverse (reply) traffic DiffServ.')], default='disable'),
    'internet-service-negate': dict(type='option', options=[('enable', 'Enable negated Internet Service match.'), ('disable', 'Disable negated Internet Service match.')], default='disable'),
    'np-acceleration': dict(type='option', options=[('enable', 'Enable NPU acceleration.'), ('disable', 'Disable NPU acceleration.')], default='enable'),
    'send-deny-packet': dict(type='option', options=[('disable', 'Disable deny-packet sending.'), ('enable', 'Enable deny-packet sending.')], default='disable'),
    'ztna-policy-redirect': dict(type='option', options=[('enable', 'Enable ZTNA policy redirect.'), ('disable', 'Disable ZTNA policy redirect.')], default='disable'),
    'arp-reply': dict(type='option', options=[('disable', 'Disable ARP reply.'), ('enable', 'Enable ARP reply.')], default='enable'),
    'dstaddr6-negate': dict(type='option', options=[('enable', 'Enable destination address negate.'), ('disable', 'Disable destination address negate.')], default='disable'),
    'srcaddr6-negate': dict(type='option', options=[('enable', 'Enable source address negate.'), ('disable', 'Disable source address negate.')], default='disable'),
    'dsri': dict(type='option', options=[('enable', 'Enable DSRI.'), ('disable', 'Disable DSRI.')], default='disable'),
    'geoip-match': dict(type='option', options=[('physical-location', 'Match geoip based on physical location.'), ('registered-location', 'Match geoip based on registered location.')], default='physical-location'),
    'http-policy-redirect': dict(type='option', options=[('enable', 'Enable HTTP(S) policy redirect.'), ('disable', 'Disable HTTP(S) policy redirect.'), ('legacy', 'Legacy HTTP(S) policy redirect.')], default='disable'),
    'natip': dict(type='ipv4-classnet', default='0.0.0.0 0.0.0.0'),
    'policy-expiry-date': dict(type='datetime'),
    'diffservcode-forward': dict(type='word', maxlen=6, default='000000'),
    'diffservcode-rev': dict(type='word', maxlen=6, default='000000'),
    'tos': dict(type='word', maxlen=4, default='0x00'),
    'tos-mask': dict(type='word', maxlen=4, default='0x00'),
    'vlan-filter': dict(type='word', maxlen=255),
    'fsso-agent-for-ntlm': dict(type='string', maxlen=35),
    'session-ttl': None,
    'src-vendor-mac': dict(type='list'),
    'ssl-dh-bits': dict(type='option', options=[(v, f'{v}-bit Diffie-Hellman prime.') for v in ('768', '1024', '1536', '2048', '3072', '4096')], default='2048'),
    'ssl-client-session-state-type': dict(type='option', options=[('disable', 'Do not keep session states.'), ('time', 'Expire session states after this many minutes.'), ('count', 'Expire session states when this maximum is reached.'), ('both', 'Expire session states based on time or count, whichever occurs first.')], default='both'),
    'ldb-method': None,
    'portmapping-type': dict(type='option', options=[('1-to-1', 'One to one.'), ('m-to-n', 'Many to many.')], default='1-to-1'),
    'ipv6-mappedip': dict(type='word', maxlen=63),
    'ipv6-mappedport': dict(type='word', maxlen=11),
    'http-multiplex-max-concurrent-request': dict(type='integer', min=0, max=2147483647, default='0'),
    'type': None,
    'status': None,
    'associated-interface': None,
}

HELP_OVERRIDES = {
    'natip': 'Policy-based IPsec VPN: source NAT IP address for outgoing traffic.',
    'policy-expiry-date': 'Policy expiry date (YYYY-MM-DD HH:MM:SS).',
    'policy-expiry-date-utc': 'Policy expiry date and time, in epoch format.',
    'tos-mask': 'Non-zero bit positions are used for comparison while zero bit positions are ignored.',
    'tos': 'ToS (Type of Service) value used for comparison.',
    'diffservcode-rev': 'Change packet\'s reverse (reply) DiffServ to this value.',
    'diffservcode-forward': 'Change packet\'s DiffServ to this value.',
    'vlan-filter': 'VLAN ranges to allow.',
}

LISTS = {'custom-log-fields', 'internet-service-custom', 'internet-service-custom-group', 'internet-service-fortiguard',
         'internet-service-group', 'internet-service-name', 'internet-service-src-custom', 'internet-service-src-custom-group',
         'internet-service-src-fortiguard', 'internet-service-src-group', 'internet-service-src-name',
         'internet-service6-custom', 'internet-service6-custom-group', 'internet-service6-fortiguard',
         'internet-service6-group', 'internet-service6-name', 'internet-service6-src-custom',
         'internet-service6-src-custom-group', 'internet-service6-src-fortiguard', 'internet-service6-src-group',
         'internet-service6-src-name', 'network-service-dynamic', 'network-service-src-dynamic', 'ntlm-enabled-browsers',
         'rtp-addr', 'sgt', 'src-vendor-mac', 'ztna-ems-tag', 'ztna-ems-tag-secondary', 'ztna-geo-tag', 'extaddr'}

REASONS = [
    (r'^internet-service', 'it matches against the FortiGuard Internet Service database, which this simulator does not ship.'),
    (r'^(network-service-dynamic|network-service-src-dynamic|reputation-|src-vendor-mac|geoip-)', 'it needs reputation, vendor-MAC or GeoIP data that this simulator does not ship.'),
    (r'^ztna-', 'ZTNA needs a FortiClient EMS and device tags, which this simulator does not model.'),
    (r'^(wanopt|webcache|wccp)', 'there is no WAN optimisation, web cache or WCCP engine behind it.'),
    (r'^(np-acceleration|delay-tcp-npu-session|dsri|fec|auto-asic)', 'this simulator has no hardware acceleration model, so the setting would have no measurable effect.'),
    (r'(-profile|^profile-)', 'there is no inspection engine behind this profile type in this simulator.'),
    (r'^(ntlm|fsso-agent-for-ntlm|radius-|disclaimer|email-collect|captive-portal-exempt|auth-)', 'the authentication portal feature it tunes is not modelled.'),
    (r'^(pcp-|rtp-|permit-|voip)', 'there is no VoIP or PCP engine behind it.'),
    (r'^(ssl-|http-|h2-|h3-|https-|weblogic|websphere|outlook|persistence|user-agent-detect|monitor)', 'the application-layer load balancer (SSL offload, HTTP persistence, multiplexing) is not modelled.'),
    (r'^(gslb|one-click-gslb|dns-mapping)', 'there is no global server load balancing or DNS translation engine behind it.'),
    (r'^(agent-id|sdn|sub-type|clearpass|fsso|tag-|tenant|epg|obj-|organization|os$|sw-version|hw-|policy-group|obsolete|fabric-object|node-ip-only|sso-attribute)', 'it belongs to dynamic address objects fed by an external connector, which this simulator does not run.'),
]
DEFAULT_REASON = 'this simulator does not evaluate it, so accepting it would store a setting with no effect.'

def reason_for(name):
    for pattern, reason in REASONS:
        if re.search(pattern, name): return reason
    return DEFAULT_REASON

def clean_help(text, name):
    pattern = re.compile(r'^' + re.escape(name).replace(r'\-', r'-\s*') + r'\*?\s*')
    text = pattern.sub('', text, count=1)
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'\s+(datetime|user|integer|string|var-string|option|ipv4-classnet-any|ipv4-address-any) Not Specified.*$', '', text)
    text = re.sub(r'^(<[^>]*>\s*)+', '', text)
    text = re.sub(r'^\*\s*', '', text)
    text = re.sub(r'\s*\*$', '', text)
    sentences, kept = re.split(r'(?<=\.)\s+', text), []
    for sentence in sentences:
        if sentence not in kept: kept.append(sentence)
    text = ' '.join(kept)
    text = re.sub(r'\.When ', '. When ', text)
    text = re.sub(r'\.,?$', '.', text)
    if not text: text = name
    if not text.endswith('.'): text += '.'
    return text[0].upper() + text[1:]

def q(s): return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"

def emit(e, schema_names):
    name = e['name']; o = OVERRIDES.get(name)
    if o: e = {**e, **o}
    typ = e.get('type', 'unknown')
    help_text = clean_help(HELP_OVERRIDES.get(name, e.get('help', name)), name)
    if typ == 'option':
        values = [(k, d) for k, d in e.get('options', []) if re.match(r'^[a-z0-9][a-z0-9_.\-]*$', k)]
        if len({k for k, _ in values}) != len(values):
            seen = set(); values = [v for v in values if not (v[0] in seen or seen.add(v[0]))]
        keys = [k for k, _ in values]
        default = e.get('default')
        if sorted(keys) == ['disable', 'enable'] and default in ('enable', 'disable'):
            body = f"enable({q(name)}, {q(help_text)}, {'true' if default == 'enable' else 'false'})"
        else:
            vals = ', '.join("{ keyword: %s, description: %s }" % (q(k), q(re.sub(r'\s+', ' ', d))) for k, d in values)
            body = f"choice({q(name)}, {q(help_text)}, [{vals}], {q(default)})"
    elif typ == 'integer':
        default = int(e['default']) if re.match(r'^-?[0-9]+$', str(e.get('default'))) else 0
        body = f"count({q(name)}, {q(help_text)}, {e['min']}, {e['max']}, {default})"
    elif name in LISTS or typ == 'list':
        body = "list(%s, %s)" % (q(name), q(help_text))
    elif typ == 'ipv4-classnet':
        body = f"addressMask({q(name)}, {q(help_text)}, ['0.0.0.0', '0.0.0.0'])"
    elif typ == 'datetime':
        body = f"{'isoMoment' if name == 'policy-expiry-date' else 'moment'}({q(name)}, {q(help_text)})"
    else:
        body = f"{'text' if typ == 'var-string' else 'word'}({q(name)}, {q(help_text)})"
    if name.startswith('diffservcode'):
        body = "{ ...%s, acceptsValue: (value: string) => /^[01]{6}$/.test(value) }" % body
    return body

def main():
    dump = json.load(open(sys.argv[1])); out_dir = sys.argv[2]
    for title, (module, const) in TABLES.items():
        entries = [{**detail(e), 'path': ''} for e in parse_toplevel(title)[0]]
        have = {a.lower() for a in dump[title]}
        lines = ["import { addressMask, choice, count, enable, isoMoment, moment, text, word, type FortiAttributeSpec } from './types';", '',
                 "const list = (name: string, help: string): FortiAttributeSpec => ({",
                 "  name, help, quoted: true, multiValue: true, parts: [{ name, type: 'WORD', description: help }],", "});", '',
                 f"export const {const}: readonly FortiAttributeSpec[] = Object.freeze(["]
        seen = set()
        for e in entries:
            if e['path'] != '' or e['name'].lower() in have or e['name'] in seen: continue
            seen.add(e['name'])
            spec = emit(e, have)
            evaluated = e['name'] in EVALUATED.get(title, [])
            if evaluated:
                lines.append(f"  {spec},")
            else:
                lines.append(f"  {{ ...{spec}, unimplemented: {q(reason_for(e['name']))} }},")
        lines += ['] as const);', '']
        open(os.path.join(out_dir, module + '.ts'), 'w').write('\n'.join(lines))
        print(title, len(seen), 'attributes ->', module + '.ts')

main()
