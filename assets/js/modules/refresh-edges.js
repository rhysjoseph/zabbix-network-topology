// SPDX-License-Identifier: AGPL-3.0-or-later
// Reuse the initial-render metric calculations;
// recolouring an edge does not refresh the data stored on that edge.
import { buildEdgeElements } from './build-elements.js';

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

export function refreshEdgeData(cy, renderedNodes, renderedEdges, data) {
    const nodeMap = new Map(data.nodes.map(function(n) { return [String(n.id), n]; }));
    const edgeMap = new Map((data.edges || []).map(function(e) { return [edgeKey(e), e]; }));
    const nodes = renderedNodes.map(function(n) { return nodeMap.get(String(n.id)) || n; });
    // Keep the rendered order: buildEdgeElements assigns 'e' + array index.
    // Looking up by backend id also survives a reordered API response and
    // avoids confusing parallel cables with the same two host endpoints.
    const edges = renderedEdges.map(function(e) { return edgeMap.get(edgeKey(e)) || e; });
    const elements = buildEdgeElements(edges, nodes);
    cy.batch(function() {
        elements.forEach(function(el) {
            const edge = cy.getElementById(String(el.data.id));
            if (!edge.length || !edge.isEdge()) return;
            // Do not update immutable endpoints or a synthetic/manual edge
            // that happens to share an id. Structure changes need a render.
            if (edge.source().id() !== el.data.source || edge.target().id() !== el.data.target) return;
            const fields = Object.assign({}, el.data);
            delete fields.id;
            delete fields.source;
            delete fields.target;
            edge.data(fields);
            // Bundle degradation is calculated by the same builder as totals.
            // Preserve unrelated selection/path/focus/simulation classes.
            edge.toggleClass('nt-par-degraded',
                (' ' + (el.classes || '') + ' ').indexOf(' nt-par-degraded ') !== -1);
        });
    });
}
