#!/usr/bin/env python3
"""Seed made-up topologies and move an LLDP neighbour in the Docker lab at port 18080."""
import argparse
import json
import subprocess
import time
import urllib.request

URL = 'http://127.0.0.1:18080/api_jsonrpc.php'
SERVER = 'zabbix-topology-lab-server-1'
PREFIX = 'nt-layout-lab-'


class Api:
    def __init__(self):
        self.token = None
        self.token = self.call('user.login', {'username': 'Admin', 'password': 'zabbix'})

    def call(self, method, params):
        headers = {'Content-Type': 'application/json-rpc'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        request = urllib.request.Request(URL, headers=headers, data=json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode())
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
        if 'error' in result:
            raise RuntimeError(f"{method}: {result['error']}")
        return result['result']


def fixture():
    nodes, edges, ghosts = {}, [], {}
    def node(name, title, role, *groups):
        nodes[name] = (title, role, groups)

    def link(a, b):
        edges.append((a, b))

    node('event-core', 'Event Core', 'spine', 'Event')
    for i, area in enumerate(('Video', 'Audio', 'Lighting', 'Control'), 1):
        name = f'event-{i}'
        node(name, f'{area} Access', 'access', 'Event')
        link('event-core', name)
        ghosts[name] = [f'{area}-endpoint-{n:02}' for n in range(1, 7)]

    for i in (1, 2):
        node(f'spine-{i}', f'Spine {i}', 'spine', 'Fabric', 'Fabric A' if i == 1 else 'Fabric B')
    for i in range(1, 7):
        area = 'Fabric A' if i <= 3 else 'Fabric B'
        node(f'leaf-{i}', f'Leaf {i}', 'leaf', 'Fabric', area)
        for j in (1, 2):
            link(f'spine-{j}', f'leaf-{i}')
        for letter in ('a', 'b'):
            name = f'access-{i}{letter}'
            node(name, f'Access {i}{letter.upper()}', 'access', 'Fabric', area)
            link(f'leaf-{i}', name)
            ghosts[name] = [f'{name}-camera-{n}' for n in range(1, 5)]
    node('guest-core', 'Media Server', None, 'Event')
    link('event-1', 'guest-core')
    for i in range(1, 5):
        node(f'guest-{i}', f'Media Guest {i}', 'endpoint', 'Event')

    # The same network groups can be selected across both sites, or split
    # into four site-specific groups for the rows/columns comparison.
    previous_core = {}
    for site in ('North', 'South'):
        for net, label in (('util', 'Utility'), ('media', 'Media 2110')):
            prefix = f'{site.lower()}-{net}'
            team = f'{site}/{label}'
            core = prefix + '-core'
            node(core, f'{site} {label} Core', None, team, label)
            if net in previous_core:
                link(previous_core[net], core)
            previous_core[net] = core
            for rack in range(1, 6):
                distribution = f'{prefix}-dist-{rack}'
                node(distribution, f'{site} {label} Dist {rack}', None, team, label)
                link(core, distribution)
                for port in range(1, 5):
                    edge = f'{prefix}-{rack}-{port}'
                    node(edge, f'{site} {label} Access {rack}.{port}', None, team, label)
                    link(distribution, edge)
            for room in ('Control Room', 'Machine Room'):
                # Use one site and a few ports for each small room.
                if site != 'North' or (room == 'Control Room') != (net == 'util'):
                    continue
                for name in [core, prefix + '-dist-1'] + [f'{prefix}-1-{i}' for i in range(1, 5)]:
                    title, role, memberships = nodes[name]
                    nodes[name] = (title, role, (*memberships, room))

    # One real endpoint with separate Red, Blue and Utility interfaces.
    node('studio-encoder', 'Studio Encoder', None, 'Studio/Utility')
    for key, label, parent in (
        ('red', 'Media Red', 'Media 2110'), ('blue', 'Media Blue', 'Media 2110'),
        ('utility', 'Utility', 'Utility'),
    ):
        name = 'studio-' + key
        memberships = tuple(sorted({'Studio/' + label, 'Studio/' + parent}))
        node(name, label + ' Edge', None, *memberships)
        node(name + '-core', label + ' Core', None, *memberships)
        link(name + '-core', name)
        link(name, 'studio-encoder')

    event = 'Live Event'
    router = 'live-router'
    node(router, 'Event Router', None, event, event + '/Routing')
    for colour in ('Red', 'Blue'):
        group = event + '/Media ' + colour
        prefix = 'live-media-' + colour.lower()
        core = prefix + '-core'
        node(core, f'Event Media {colour} Core', 'spine', event, group)
        link(router, core)
        for i in range(1, 4):
            leaf = f'{prefix}-leaf-{i:02}'
            node(leaf, f'Media {colour} Leaf {i:02}', 'leaf', event, group)
            link(core, leaf)

    utility = event + '/Utility'
    utility_cores = ['live-utility-core-a', 'live-utility-core-b']
    for core, letter in zip(utility_cores, ('A', 'B')):
        node(core, f'Utility Core {letter}', 'spine', event, utility)
        link(router, core)
    for i in range(1, 21):
        access = f'live-utility-access-{i:02}'
        node(access, f'Utility Access {i:02}', 'access', event, utility)
        for core in utility_cores:
            link(access, core)
    return nodes, edges, ghosts


def readings(edges, ghosts, moved=False):
    # The smaller fixtures use one-sided LLDP. Live Event reports both ends
    # of each cable. The Event uplink test changes only its reported neighbour.
    ports = {}
    rows = []
    def next_port(host):
        ports[host] = ports.get(host, 0) + 1
        return ports[host]

    def lldp(a, b, port, remote):
        target = PREFIX + b if isinstance(b, str) else b[0]
        for field, value in (
            ('SysName', target), ('PortDesc', remote), ('PortId', remote)
        ):
            rows.append((PREFIX + a, f'lldpRem{field}[0.{port}.1]', value, 1))
    for a, b in edges:
        if a.startswith('live-'):
            local, remote = next_port(a), next_port(b)
            lldp(a, b, local, f'Gi1/0/{remote}')
            lldp(b, a, remote, f'Gi1/0/{local}')
            continue
        if moved and a == 'event-core' and b == 'event-4':
            b = ('Temporary-Recorder',)
        remote = 'Gi1/0/1'
        if b == 'studio-encoder':
            remote = 'Ethernet' + {'studio-red': '1', 'studio-blue': '2', 'studio-utility': '3'}[a]
        lldp(a, b, next_port(a), remote)
    for a, names in ghosts.items():
        for name in names:
            lldp(a, (name,), next_port(a), 'Gi1/0/1')
    return rows


def send(rows):
    data = ''.join(f'{h} {key} {json.dumps(v)}\n' for h, key, v, _ in rows)
    for attempt in range(14):
        done = subprocess.run(['docker', 'exec', '-i', SERVER, 'zabbix_sender',
                               '-z', '127.0.0.1', '-i', '-'],
                              input=data, text=True, capture_output=True)
        if done.returncode == 0:
            print(done.stdout.strip())
            return
        time.sleep(2)
    raise RuntimeError(done.stderr + done.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['seed', 'move', 'restore', 'groups'])
    args = parser.parse_args()
    nodes, edges, ghosts = fixture()
    rows = readings(edges, ghosts, args.action == 'move')
    if args.action in ('move', 'restore'):
        send(rows)
        return
    api = Api()
    group_ids = {}
    for name in sorted({g for _, _, groups in nodes.values() for g in groups}):
        group = 'Topology Layout Lab/' + name
        existing = api.call('hostgroup.get', {'filter': {'name': [group]}})
        if existing:
            group_ids[name] = existing[0]['groupid']
        elif args.action == 'seed':
            group_ids[name] = api.call('hostgroup.create', {'name': group})['groupids'][0]
    print(json.dumps(group_ids))
    if args.action == 'groups':
        return
    hosts = {}
    for name, (title, role, groups) in nodes.items():
        host = PREFIX + name
        is_server = name.startswith('guest-') or name == 'studio-encoder'
        icon = 'router' if name == 'live-router' else ('server' if is_server else 'switch')
        tags = [{'tag': 'nt:icon', 'value': icon}]
        if role:
            tags.append({'tag': 'nt:tier', 'value': role})
        if name.startswith('guest-') and name != 'guest-core':
            tags.append({'tag': 'nt:parent', 'value': PREFIX + 'guest-core'})
        params = {'name': title, 'tags': tags,
                  'groups': [{'groupid': group_ids[g]} for g in groups]}
        existing = api.call('host.get', {'filter': {'host': [host]}})
        if existing:
            hid = existing[0]['hostid']
            api.call('host.update', {**params, 'hostid': hid})
        else:
            hid = api.call('host.create', {**params, 'host': host})['hostids'][0]
        hosts[host] = hid
    current = {(str(i['hostid']), i['key_']) for i in api.call('item.get', {
        'hostids': list(hosts.values()), 'output': ['hostid', 'key_']})}
    items = [{'hostid': hosts[h], 'name': key, 'key_': key, 'type': 2,
              'value_type': kind, 'delay': '0', 'history': '7d', 'trends': '0',
              'trapper_hosts': '127.0.0.1'}
             for h, key, _, kind in rows if (hosts[h], key) not in current]
    if items:
        api.call('item.create', items)
    subprocess.run(['docker', 'exec', SERVER, 'zabbix_server', '-R', 'config_cache_reload'],
                   check=True)
    send(rows)


if __name__ == '__main__':
    main()
