# Prepare older history for the topology map

Use this optional worker on a Zabbix frontend backed by MariaDB with
`RANGE(clock)` history partitions and a primary index on
`(itemid, clock, ns)`. It prepares the latest older sample for each
topology item in one host group. The frontend reads newer partitions live
and checks item permissions before using the prepared values.

The worker reads the Zabbix database and writes files to
`/var/cache/zabbix-network-topology/history-v1`. It uses the frontend
database configuration and runs as the frontend's Unix user. For an
alternate configuration path, set `TOPOLOGY_HISTORY_ZABBIX_CONFIG` in the
worker environment. PHP CLI needs the mysqli extension.

On a Debian-style frontend with the module in
`/usr/share/zabbix/modules/network_topology` and web user `www-data`, run
these commands from this directory. Substitute the desired Zabbix host
group ID for `123`.

```sh
sudo install -d -m 0700 -o www-data -g www-data /var/cache/zabbix-network-topology/history-v1
sudo install -D -m 0644 history-worker.php /usr/local/lib/zabbix-network-topology/history-worker.php
sudo -u www-data php -d memory_limit=256M /usr/local/lib/zabbix-network-topology/history-worker.php \
    prepare /usr/share/zabbix/modules/network_topology 123
printf 'TOPOLOGY_HISTORY_GROUP_ID=123\n' | sudo tee /etc/default/zabbix-topology-history
sudo install -m 0644 zabbix-topology-history.service zabbix-topology-history.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zabbix-topology-history.timer
```

The timer rebuilds the files hourly, so late samples in closed partitions
can take up to one run to appear. The frontend falls back to the partition
query for uncovered items, an incompatible partition layout, or prepared
data older than three hours. To stop preparation, disable the timer and
stop the worker with `systemctl`. The files expire automatically.
