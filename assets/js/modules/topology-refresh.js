// SPDX-License-Identifier: AGPL-3.0-or-later

import { fetchJson } from './http.js';
import { t } from './i18n.js';

const pending = new Map();
let stopRefresh = null;

function requestTopology(url) {
    if (!pending.has(url)) {
        pending.set(url, fetchJson(url, { cache: 'no-store' })
            .finally(function() { pending.delete(url); }));
    }
    return pending.get(url);
}

function retryDelay(data) {
    const seconds = Number(data && data.retry_after);
    return seconds > 0 ? Math.min(seconds, 30) * 1000 + Math.random() * 1000 : 0;
}

export async function loadTopology(url) {
    const deadline = Date.now() + 120000;
    let data = await requestTopology(url);
    let delay = retryDelay(data);
    while (delay && !data.nodes && Date.now() < deadline) {
        await new Promise(function(resolve) { setTimeout(resolve, delay); });
        data = await requestTopology(url);
        delay = retryDelay(data);
    }
    return data;
}

export function stopTopologyRefresh() {
    if (stopRefresh) stopRefresh();
    stopRefresh = null;
}

export function startTopologyRefresh(url, interval, isActive, apply, onError) {
    stopTopologyRefresh();
    if (!url) return;

    let timer;
    let stopped = false;
    stopRefresh = function() {
        stopped = true;
        clearTimeout(timer);
    };

    function schedule(delay) {
        timer = setTimeout(refresh, delay || interval + Math.random() * 1500);
    }

    async function refresh() {
        let next = 0;
        try {
            if (!isActive()) return;
            const data = await requestTopology(url);
            if (stopped || !isActive()) return;
            next = retryDelay(data);
            apply(data);
        } catch (error) {
            if (!stopped && isActive() && onError) onError(error);
        } finally {
            if (!stopped) schedule(next);
        }
    }

    schedule(retryDelay(window._ntLastData));
}

export function showSnapshotStatus(wrap, data, lastSnapshotAt) {
    let badge = document.getElementById('nt-snapshot-status');
    if (!data || (!data.snapshot_stale && !data.retry_after)) {
        if (badge) badge.remove();
        return;
    }

    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'nt-snapshot-status';
        badge.setAttribute('role', 'status');
        badge.style.cssText = 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);z-index:1000;'
            + 'background:var(--nt-warn-bg,#fef3c7);color:var(--nt-warn-text,#92400e);'
            + 'border:1px solid #f59e0b;border-radius:6px;padding:4px 10px;font:600 11px sans-serif';
        wrap.appendChild(badge);
    }

    const at = data.snapshot_at || lastSnapshotAt;
    badge.textContent = at
        ? t('app.snapshot_stale', { time: new Date(at * 1000).toLocaleTimeString() })
        : t('app.loading');
}

// Preserve the page's URL and ancillary fields when a refresh is pending.
// A late response cannot replace a snapshot the map already applied.
export function acceptTopologySnapshot(data, url) {
    const last = window._ntLastData || {};
    last.retry_after = data.retry_after || 0;
    window._ntLastData = last;
    if (!data.nodes || (data.snapshot_at && data.snapshot_at <= last.snapshot_at)) return false;

    Object.assign(last, {
        nodes: data.nodes,
        edges: data.edges || [],
        lldp_quality: data.lldp_quality || [],
        expected_links: data.expected_links || null,
        snapshot_at: data.snapshot_at || 0,
        url: url
    });
    return true;
}

function edgeKey(e) {
    if (e.id !== undefined && e.id !== null) return 'id:' + String(e.id);
    return JSON.stringify([String(e.source || e.from || ''),
        String(e.target || e.to || ''), e.ports || {}, e._type || e.kind || '']);
}

// Metric changes stay in place. A changed graph uses the existing full-render
// path, including its focus, ghost, aggregation and layout handling.
export function topologySignature(nodes, edges, quality) {
    return JSON.stringify([
        nodes.map(function(n) { return [String(n.id), n.type || '']; }).sort(),
        edges.map(function(e) {
            return [edgeKey(e), String(e.source || e.from || ''),
                String(e.target || e.to || ''), !!e.stale, e._type || e.kind || '',
                e.ports || {}, e.port_idx || {}];
        }).sort(),
        (quality || []).map(function(q) {
            return [String(q.id), q.unmatched || []];
        }).sort()
    ]);
}
