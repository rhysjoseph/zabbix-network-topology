<?php
// SPDX-License-Identifier: AGPL-3.0-or-later
// Lokale Erweiterung vom 2026-11-02: erfundene Discovery-Namen, keine SNMP-Abfragen.
declare(strict_types=1);
spl_autoload_register(static function(string $class): void {
    $prefix = 'Modules\\NetworkTopology\\';
    if (strpos($class, $prefix) !== 0) return;
    $parts = explode('\\', substr($class, strlen($prefix)));
    $file = array_pop($parts);
    require dirname(__DIR__) . '/' . strtolower(implode('/', $parts)) . '/' . $file . '.php';
});
use Modules\NetworkTopology\Topology\MetricExtractor;
use Modules\NetworkTopology\Topology\LldpEdgeBuilder;

function check($got, $want, string $message): void {
    if ($got !== $want) throw new RuntimeException($message . ': ' . var_export($got, true));
    echo "PASS $message\n";
}
function item(string $key, string $value, array $tags=[]): array {
    return ['hostid'=>'a', 'key_'=>$key, 'lastvalue'=>$value, 'tags'=>$tags];
}
$items = [];
for ($i=1; $i<=4; $i++) {
    $items[] = item('net.if.status[ifOperStatus.'.$i.']', $i===2?'2':'1',
        [['tag'=>'interface', 'value'=>'1/0/'.$i], ['tag'=>'description','value'=>'Example uplink']]);
    $items[] = item('net.if.in[ifHCInOctets.'.$i.']', (string) ($i*1000));
}
$m = MetricExtractor::extract($items);
for ($i=1; $i<=4; $i++) check($m['port_names']['a'][$i], '1/0/'.$i, 'Netgear discovered name for index '.$i);
$r = LldpEdgeBuilder::build(
    ['a'=>['host'=>'lab-netgear','name'=>'lab-netgear'], 'b'=>['host'=>'lab-peer','name'=>'lab-peer']],
    [['hostid'=>'a','key_'=>'lldpRemSysName[0.2.1]','lastvalue'=>'lab-peer','src'=>'lldp']],
    [], $m['port_traffic'], [], [], [], [], $m['port_names'], [], $m['port_status']
);
$edge = $r['edges'][0];
check($edge['ports']['a'], '1/0/2', 'map label uses discovered physical name');
check($edge['port_idx']['a'], '2', 'numeric ifIndex remains unchanged');
check($edge['port_metrics']['a']['down'], true, 'down state stays on interface 2');
check($edge['port_metrics']['a']['in'], 2000.0, 'traffic stays on interface 2');
$tag = [['tag'=>'interface','value'=>'1/0/1']];
$base = item('net.if.status[ifOperStatus.1]', '1', $tag);
$m = MetricExtractor::extract([$base, item('nt.if.name[ifName.1]', 'ExplicitName')]);
check($m['port_names']['a'][1], 'ExplicitName', 'explicit ifName keeps priority');
$m = MetricExtractor::extract([$base, item('nt.if.alias[ifAlias.1]', 'To another switch')]);
check($m['port_names']['a'][1], '1/0/1', 'discovered name wins over free-form alias');
$other = item('ifOperStatus[1]', '1', [['tag'=>'interface','value'=>'2/0/1']]);
$m = MetricExtractor::extract([$base, $other]);
check($m['port_names']['a'][1] ?? null, null, 'conflicting discovered names are rejected');
$m = MetricExtractor::extract([item('net.if.in[ifHCInOctets.1]', '9000', $tag)]);
check($m['port_names'], [], 'traffic item tags alone cannot classify an interface');
$m = MetricExtractor::extract([item('net.if.status[eth0]', '1', $tag)]);
check($m['port_names'], [], 'agent interface names are not guessed as SNMP indices');
$m = MetricExtractor::extract([item('net.if.status[7]', '1', [['tag'=>'interface','value'=>'3/0/12']])]);
check($m['port_names']['a'][7], '3/0/12', 'bare numeric SNMP status key is supported');
$m = MetricExtractor::extract([$base, item('ifOperStatus[1]', '1', $tag)]);
check($m['port_names']['a'][1], '1/0/1', 'repeated agreeing status tags remain unambiguous');
$m = MetricExtractor::extract([item('ifOperStatus[1]', '1', [['tag'=>'interface','value'=>'  ']])]);
check($m['port_names'], [], 'blank interface tags do not create labels');
