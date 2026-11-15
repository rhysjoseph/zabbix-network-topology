// SPDX-License-Identifier: AGPL-3.0-or-later

import { fetchJson } from './http.js';
import { followsLayout, layoutFollowView, setFollowLayout } from './storage.js';

const POLL_MS = 5000;

// The live viewer has its own timer and revision. It does not adopt the
// editor's write revision or run a layout, and never changes pan or zoom.
export function setupLayoutFollow(cy, report) {
    const view = layoutFollowView();
    const endpoint = (window.NT_CONFIG || {}).positions_url;
    let active = false;
    let revision = '';
    let timer;
    let pending;

    function stop() {
        active = false;
        clearTimeout(timer);
        if (pending) pending.abort();
        pending = null;
    }

    async function poll() {
        if (!active || cy.destroyed() || !followsLayout()) return;
        const controller = new window.AbortController();
        pending = controller;
        // Allow a slow or failed request to recover without overlapping polls.
        const timeout = setTimeout(() => controller.abort(), POLL_MS);
        const url = endpoint + '&' + new URLSearchParams({view, since: revision});
        try {
            const data = await fetchJson(url, {cache: 'no-store', signal: controller.signal});
            if (!active || pending !== controller || cy.destroyed() || !followsLayout()) return;
            if (!data || !data.ok || typeof data.revision !== 'string') {
                report('retry');
                return;
            }
            if (data.positions) {
                cy.batch(function() {
                    for (const [id, point] of Object.entries(data.positions)) {
                        const node = cy.getElementById(id);
                        if (!node.length || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
                        const locked = node.locked();
                        if (locked) node.unlock();
                        node.position(point);
                        if (locked) node.lock();
                    }
                });
            }
            revision = data.revision;
            report('on');
        } catch (e) {
            if (active && pending === controller) report('retry');
        } finally {
            clearTimeout(timeout);
            if (pending === controller) {
                pending = null;
                if (active) timer = setTimeout(poll, POLL_MS);
            }
        }
    }

    function apply() {
        stop();
        active = !!(endpoint && view && followsLayout());
        cy.autoungrabify(active);
        revision = '';
        report(active ? 'waiting' : 'off');
        if (active) timer = setTimeout(poll, 1000);
    }

    cy.one('destroy', stop);
    cy.on('layoutstop', function() { revision = ''; });
    apply();
    return function toggle() {
        setFollowLayout(!followsLayout());
        apply();
    };
}
