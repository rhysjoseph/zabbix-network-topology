<?php
declare(strict_types=1);

namespace Modules\NetworkTopology\Actions { class NetworkTopologyController {} }

namespace {
    use Modules\NetworkTopology\Actions\NetworkTopologyData;
    use Modules\NetworkTopology\Actions\NtPreparedHistory;

    function DBselect(string $query): mysqli_result {
        return $GLOBALS['history_db']->query($query);
    }

    function DBfetch(mysqli_result $cursor, bool $convertNulls = true): array|false {
        return $cursor->fetch_assoc() ?: false;
    }

    class Manager {
        public static function History(): self {
            return new self();
        }

        public function getDataSourceType(int $type): string {
            return ZBX_HISTORY_SOURCE_SQL;
        }
    }

    function selectItems(int $group): array {
        $rows = DBselect('SELECT i.itemid, i.hostid, i.key_, i.value_type
            FROM hosts_groups g JOIN hosts h ON h.hostid=g.hostid
            JOIN items i ON i.hostid=h.hostid
            WHERE g.groupid=' . $group . ' AND h.status=0 AND i.status=0 AND i.flags IN (0,4)
            AND i.value_type IN (0,1,3,4) ORDER BY i.itemid LIMIT 100001')->fetch_all(MYSQLI_ASSOC);
        if (!$rows || count($rows) > 100000) {
            throw new RuntimeException('Group item count outside preparation bounds');
        }
        $tagged = DBselect("SELECT DISTINCT t.value FROM hosts_groups g
            JOIN host_tag t ON t.hostid=g.hostid WHERE g.groupid=$group AND t.tag='nt:show'")->fetch_all(MYSQLI_ASSOC);
        $wanted = array_fill_keys(array_column($tagged, 'value'), true);
        $items = [];
        foreach ($rows as $row) {
            $key = $row['key_'];
            $selected = isset($wanted[$key]);
            foreach (NetworkTopologyData::HISTORY_ITEM_KEYS as $needle) {
                if (stripos($key, $needle) !== false) {
                    $selected = true;
                    break;
                }
            }
            if ($selected) {
                $items[(int) $row['itemid']] = $row;
            }
        }
        if (!$items) {
            throw new RuntimeException('Group has no topology history items');
        }
        return $items;
    }

    function historicalRows(ReflectionMethod $method, string $source, array $ids): Generator {
        try {
            yield from DBselect($method->invoke(null, $source, $ids, false, null, true));
        } catch (mysqli_sql_exception $error) {
            if ($error->getCode() !== 1969 || count($ids) <= 25) {
                throw $error;
            }
            foreach (array_chunk($ids, (int) ceil(count($ids) / 2)) as $half) {
                yield from historicalRows($method, $source, $half);
            }
        }
    }

    function writeJson(string $path, array $payload): void {
        $json = json_encode($payload, JSON_THROW_ON_ERROR);
        if (file_put_contents($path, $json) !== strlen($json)) {
            throw new RuntimeException('Could not write the prepared history files');
        }
    }

    function removeGeneration(string $path): void {
        foreach (glob($path . '/*.json') as $file) {
            unlink($file);
        }
        rmdir($path);
    }

    function prepare(array $items, int $now): void {
        $root = NtPreparedHistory::DIRECTORY;
        if (!is_dir($root) || !is_writable($root)) {
            throw new RuntimeException('Prepared history directory is unavailable');
        }
        $lock = fopen($root . '/prepare.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            throw new RuntimeException('A prepared history build is already running');
        }
        $generation = bin2hex(random_bytes(12));
        $stage = $root . '/build-' . $generation;
        $ready = $root . '/' . $generation;
        $pointer = $root . '/ready-' . $generation . '.json';
        if (!mkdir($stage, 0700)) {
            throw new RuntimeException('Could not stage a history generation');
        }
        $start = hrtime(true);
        $plan = new ReflectionMethod(NetworkTopologyData::class, 'lastValueSql');
        $manifest = ['generation' => $generation, 'items' => count($items), 'tables' => []];
        try {
            foreach (NtPreparedHistory::TABLES as $kind => $table) {
                $partitions = NtPreparedHistory::parsePartitions(DBselect(NtPreparedHistory::partitionSql($table)));
                $closed = NtPreparedHistory::olderPartitions($partitions, $now);
                if (!$closed) {
                    throw new RuntimeException('Expected closed clock partitions for ' . $table);
                }
                $cutoff = reset($closed);
                $missing = [];
                foreach ($items as $id => $item) {
                    if ((int) $item['value_type'] === $kind) {
                        $missing[$id] = true;
                    }
                }
                $entries = array_fill_keys(array_keys($missing), null);
                foreach ($closed as $name => $end) {
                    if (!$missing) {
                        break;
                    }
                    $source = $table . ' PARTITION (' . $name . ')';
                    if (!DBfetch(DBselect('SELECT itemid FROM ' . $source . ' LIMIT 1'))) {
                        continue;
                    }
                    foreach (array_chunk(array_keys($missing), 200) as $ids) {
                        foreach (historicalRows($plan, $source, $ids) as $row) {
                            if ($row['latest'] === null) {
                                continue;
                            }
                            $id = (int) $row['itemid'];
                            [$clock, $value] = explode(':', $row['latest'], 2);
                            $entries[$id] = [$name, (int) $clock, $value];
                            unset($missing[$id]);
                        }
                    }
                }
                $buckets = [];
                foreach ($entries as $id => $entry) {
                    $buckets[intdiv($id, NtPreparedHistory::BUCKET_SIZE)][$id] = $entry;
                }
                foreach ($buckets as $bucket => $payload) {
                    writeJson($stage . '/' . $table . '-' . $bucket . '.json', $payload);
                }
                $manifest['tables'][$table] = ['cutoff' => $cutoff, 'older' => $closed];
                printf("%s: %d values, %d items without older values\n",
                    $table, count($entries) - count($missing), count($missing));
                unset($entries, $buckets, $payload);
            }
            foreach ($manifest['tables'] as $table => $data) {
                $current = NtPreparedHistory::parsePartitions(DBselect(NtPreparedHistory::partitionSql($table)));
                if (NtPreparedHistory::olderPartitions($current, $data['cutoff']) !== $data['older']) {
                    throw new RuntimeException('History partitions changed during preparation');
                }
            }
            $manifest['finished'] = time();
            writeJson($pointer, $manifest);
            if (!rename($stage, $ready) || !rename($pointer, $root . '/ready.json')) {
                throw new RuntimeException('Could not publish prepared history');
            }
            foreach (glob($root . '/*', GLOB_ONLYDIR) as $directory) {
                if (preg_match('/^(build-)?[0-9a-f]{24}$/D', basename($directory))
                    && $directory !== $ready && filemtime($directory) < time() - NtPreparedHistory::MAX_AGE) {
                    removeGeneration($directory);
                }
            }
            printf("PREPARED %d items in %.2fs\n", count($items), (hrtime(true) - $start) / 1e9);
        } finally {
            if (is_dir($stage)) {
                removeGeneration($stage);
            }
            if (is_file($pointer)) {
                unlink($pointer);
            }
            fclose($lock);
        }
    }

    function verify(array $items): void {
        $reader = new ReflectionClass(NetworkTopologyData::class);
        $start = hrtime(true);
        $actual = $reader->getMethod('fetchLastValues')->invoke($reader->newInstanceWithoutConstructor(), $items);
        $seconds = (hrtime(true) - $start) / 1e9;
        $found = count($actual['values']);
        $newest = $actual['clocks'] ? max($actual['clocks']) : 0;
        printf("PROBE %.3fs, %d/%d values, newest sample age %ds\n",
            $seconds, $found, count($items), time() - $newest);
        if ($seconds >= 20 || $found < count($items) / 2 || $newest < time() - 600) {
            throw new RuntimeException('History probe missed its timing or coverage target');
        }
    }

    try {
        if (PHP_SAPI !== 'cli' || count($argv) < 4 || !ctype_digit($argv[3])
            || !in_array($argv[1], ['prepare', 'probe'], true)) {
            throw new RuntimeException('Usage: history-worker.php prepare|probe module-directory group-id [fixture-clock]');
        }
        umask(0077);
        require '/usr/share/zabbix/include/defines.inc.php';
        require getenv('TOPOLOGY_HISTORY_ZABBIX_CONFIG') ?: '/usr/share/zabbix/conf/zabbix.conf.php';
        require $argv[2] . '/actions/NetworkTopologyData.php';
        if ($DB['TYPE'] !== 'MYSQL' || !empty($HISTORY['url']) || !empty($HISTORY_PROVIDERS)) {
            throw new RuntimeException('Expected SQL history on MariaDB');
        }
        mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
        $history_db = new mysqli($DB['SERVER'] ?: 'localhost', $DB['USER'], $DB['PASSWORD'],
            $DB['DATABASE'], (int) $DB['PORT'] ?: 3306);
        unset($DB['PASSWORD']);
        $history_db->set_charset('utf8mb4');
        $history_db->query('SET SESSION MAX_STATEMENT_TIME=2.5, lock_wait_timeout=3');
        $items = selectItems((int) $argv[3]);
        if ($argv[1] === 'prepare') {
            prepare($items, isset($argv[4]) ? (int) $argv[4] : time());
        } else {
            verify($items);
        }
    } catch (Throwable $error) {
        $message = $error instanceof mysqli_sql_exception ? 'SQL error ' . $error->getCode() : $error->getMessage();
        fwrite(STDERR, 'Prepared topology history: ' . $message . "\n");
        exit(1);
    }
}
