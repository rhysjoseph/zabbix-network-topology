<?php
declare(strict_types=1);

namespace Modules\NetworkTopology\Actions;

final class NtPreparedHistory {
    public const DIRECTORY = '/var/cache/zabbix-network-topology/history-v1';
    public const MAX_AGE = 10800;
    public const BUCKET_SIZE = 512;
    public const TABLES = [0 => 'history', 1 => 'history_str', 3 => 'history_uint', 4 => 'history_text'];

    private array $manifest;

    public function __construct() {
        $manifest = json_decode(@file_get_contents(self::DIRECTORY . '/ready.json') ?: '', true);
        $this->manifest = is_array($manifest)
            && preg_match('/^[0-9a-f]{24}$/D', $manifest['generation'] ?? '')
            && is_int($manifest['finished'] ?? null)
            && time() - $manifest['finished'] <= self::MAX_AGE ? $manifest : [];
    }

    /** Partition bounds in descending order. A null upper bound is MAXVALUE. */
    public static function partitionSql(string $table): string {
        return "SELECT PARTITION_NAME AS partition_name, PARTITION_DESCRIPTION AS range_end"
            . " FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='" . $table . "'"
            . " AND PARTITION_METHOD='RANGE' AND REPLACE(PARTITION_EXPRESSION, '`', '')='clock'"
            . " AND SUBPARTITION_NAME IS NULL ORDER BY PARTITION_ORDINAL_POSITION DESC";
    }

    public static function parsePartitions(iterable $rows): array {
        $partitions = [];
        foreach ($rows as $row) {
            $name = $row['partition_name'];
            $end = (string) $row['range_end'];
            if (!preg_match('/^[A-Za-z0-9_]+$/D', $name) || ($end !== 'MAXVALUE' && !ctype_digit($end))) {
                return [];
            }
            $partitions[$name] = $end === 'MAXVALUE' ? null : (int) $end;
        }
        return $partitions;
    }

    public static function olderPartitions(array $partitions, int $cutoff): array {
        return array_filter($partitions, static fn(?int $end): bool => $end !== null && $end <= $cutoff);
    }

    public function cutoff(string $table, array $partitions): ?int {
        $data = $this->manifest['tables'][$table] ?? [];
        $cutoff = $data['cutoff'] ?? null;
        if (!is_int($cutoff)) {
            return null;
        }
        $older = self::olderPartitions($partitions, $cutoff);
        // Normal retention drops the oldest partitions, a suffix of this list.
        // A different layout needs a fresh preparation before using the cache.
        return $older === array_slice($data['older'], 0, count($older), true) ? $cutoff : null;
    }

    /** IDs come from the permission-filtered Zabbix Item API. */
    public function fill(string $table, array $partitions, array &$missing,
            array &$values, array &$clocks): void {
        $buckets = [];
        foreach (array_keys($missing) as $id) {
            $buckets[intdiv($id, self::BUCKET_SIZE)][] = $id;
        }
        foreach ($buckets as $bucket => $ids) {
            $path = self::DIRECTORY . '/' . $this->manifest['generation'] . '/' . $table . '-' . $bucket . '.json';
            $entries = json_decode(@file_get_contents($path) ?: '', true);
            if (!is_array($entries)) {
                continue;
            }
            foreach ($ids as $id) {
                if (!array_key_exists($id, $entries)) {
                    continue;
                }
                unset($missing[$id]);
                $entry = $entries[$id];
                if ($entry !== null && array_key_exists($entry[0], $partitions)) {
                    [, $clocks[$id], $values[$id]] = $entry;
                }
            }
        }
    }
}
