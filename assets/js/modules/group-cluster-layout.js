// Lay out each host group in model coordinates and place the resulting bounds
// side by side or one below another. The browser fits the whole map afterward.

import { buildLayoutConfig } from './layouts.js';
import { fitTopology, separateLayoutNodes } from './layout-spacing.js';

const GAP = 160;
const CELL_GAP = 50;
const NETWORK_TYPES = new Set(['switch', 'router', 'firewall', 'wireless']);

// Attachments with one clear host group travel with their switch. A shared
// neighbour that spans groups stays unassigned.
export function assignAttachmentGroups(nodes, edges, groupNames) {
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const neighbours = new Map();
    const connectedGroups = new Map();
    const groupOrder = new Map(groupNames.map((name, i) => [name, i]));
    for (const node of nodes) {
        delete node._connectedGroups;
        delete node._sharedAfter;
    }
    function collect(id, other, physical) {
        const attachment = byId.get(id);
        const host = byId.get(other);
        if (!attachment || !host || !groupOrder.has(host._primaryGroup)) return;
        if (attachment._isGhost || attachment._isEndpointBundle) {
            if (!neighbours.has(attachment)) neighbours.set(attachment, new Set());
            neighbours.get(attachment).add(host._primaryGroup);
        } else if (physical && !attachment._isAggregate && !attachment._isInternet
                && !NETWORK_TYPES.has(attachment.type) && NETWORK_TYPES.has(host.type)) {
            if (!connectedGroups.has(attachment)) connectedGroups.set(attachment, new Set());
            connectedGroups.get(attachment).add(host._primaryGroup);
        }
    }
    for (const edge of edges) {
        const source = String(edge.source !== undefined ? edge.source : edge.from);
        const target = String(edge.target !== undefined ? edge.target : edge.to);
        const physical = !edge.stale && Array.isArray(edge.src)
            && edge.src.some(src => src === 'lldp' || src === 'cdp' || src === 'tag');
        collect(source, target, physical);
        collect(target, source, physical);
    }
    for (const [attachment, groups] of neighbours) {
        if (groups.size === 1) attachment._primaryGroup = groups.values().next().value;
    }
    for (const [endpoint, groups] of connectedGroups) {
        if (groups.size < 2) continue;
        const ordered = [...groups].sort((a, b) => groupOrder.get(a) - groupOrder.get(b));
        const first = groupOrder.get(ordered[0]);
        const last = groupOrder.get(ordered[ordered.length - 1]);
        endpoint._connectedGroups = ordered;
        endpoint._sharedAfter = groupNames[Math.floor((first + last) / 2)];
    }
}

function buildClusterLayoutConfig(bounds, count, id) {
    const discrete = {
        grid: {avoidOverlap: true},
        breadthfirst: {directed: false, spacingFactor: 1.3, avoidOverlap: true},
        concentric: {minNodeSpacing: CELL_GAP, avoidOverlap: true},
        circle: {avoidOverlap: true}
    };
    const common = {animate: false, fit: false, nodeDimensionsIncludeLabels: true};
    if (Object.prototype.hasOwnProperty.call(discrete, id)) {
        return {...common, name: id, boundingBox: bounds, ...discrete[id]};
    }
    // The bundled CoSE can produce invalid coordinates with a bounding box.
    return {...common, name: 'cose', randomize: true, nodeRepulsion: 6000,
        idealEdgeLength: 100, gravity: 0.8, componentSpacing: CELL_GAP,
        numIter: count < 6 ? 500 : 1000};
}

const BOUNDS_OPTIONS = {includeLabels: true, includeOverlays: false, includeEdges: false};

function groupBounds(nodes) {
    let width = 0;
    let height = 0;
    nodes.forEach(function(node) {
        const bounds = node.boundingBox(BOUNDS_OPTIONS);
        width = Math.max(width, bounds.w);
        height = Math.max(height, bounds.h);
    });
    const columns = Math.ceil(Math.sqrt(nodes.length));
    return {x1: 0, y1: 0, w: columns * (width + CELL_GAP),
        h: Math.ceil(nodes.length / columns) * (height + CELL_GAP)};
}

export function runGroupClusterLayout(cy, groupNames, mode, onComplete, innerLayoutId) {
    if (!cy || cy.destroyed()) return;
    if (groupNames.length < 2 || mode === 'off' || mode === 'colors') {
        if (onComplete) onComplete();
        return;
    }
    const columns = mode === 'columns' || (mode === 'auto' && groupNames.length <= 3);
    const members = new Map(groupNames.map(name => [name, {nodes: [], edges: []}]));
    const shared = new Map();
    const unassigned = {nodes: [], edges: []};
    const assigned = new Map();

    cy.nodes('[!isGroup]').forEach(function(node) {
        if (node.data('_isAggregate') || node.locked()) return;
        const anchor = node.data('_sharedAfter');
        let group = members.get(node.data('_primaryGroup')) || unassigned;
        if (anchor) {
            if (!shared.has(anchor)) shared.set(anchor, {nodes: [], edges: []});
            group = shared.get(anchor);
        }
        group.nodes.push(node);
        assigned.set(node.id(), group);
    });

    cy.edges().forEach(function(edge) {
        const group = assigned.get(edge.source().id());
        if (group && group === assigned.get(edge.target().id())) group.edges.push(edge);
    });

    const groups = [];
    for (const [name, group] of members) {
        if (group.nodes.length) groups.push(group);
        if (shared.has(name)) groups.push(shared.get(name));
    }
    if (unassigned.nodes.length) groups.push(unassigned);
    const done = function() {
        if (cy.destroyed()) return;
        const pinned = cy.nodes(':locked');
        const pinnedBounds = pinned.length ? pinned.boundingBox(BOUNDS_OPTIONS) : null;
        // Keep the packed groups clear of any nodes fixed by the operator.
        let cursor = pinnedBounds ? (columns ? pinnedBounds.x2 : pinnedBounds.y2) + GAP : 0;
        cy.batch(function() {
            for (const group of groups) {
                const nodes = group.collection;
                const bounds = nodes.boundingBox(BOUNDS_OPTIONS);
                const x = (columns ? cursor : 0) - bounds.x1;
                const y = (columns ? 0 : cursor) - bounds.y1;
                // Cytoscape positions() resolves by element index. Snapshot
                // the previous coordinates before translating the group.
                const positions = new Map(nodes.map(n => [n.id(), n.position()]));
                nodes.positions(n => {
                    const p = positions.get(n.id());
                    return {x: p.x + x, y: p.y + y};
                });
                cursor += (columns ? bounds.w : bounds.h) + GAP;
            }
        });
        fitTopology(cy, cy.nodes(), 45);
        if (onComplete) onComplete();
    };

    if (!groups.length) {
        done();
        return;
    }

    let running = groups.length;
    for (const group of groups) {
        const nodes = group.collection = cy.collection(group.nodes);
        const bounds = groupBounds(nodes);
        const elements = nodes.union(cy.collection(group.edges));
        const options = innerLayoutId === 'hierarchy' ? {
            ...buildLayoutConfig('hierarchy', nodes.map(node => node.data()),
                group.edges.map(edge => edge.data()), true),
            animate: false, fit: false, stop: undefined
        } : buildClusterLayoutConfig(bounds, nodes.length, innerLayoutId);
        const layout = elements.layout(options);
        layout.one('layoutstop', function() {
            nodes.forEach(function(node, i) {
                const p = node.position();
                if (Number.isFinite(p.x) && Number.isFinite(p.y)) return;
                const step = Math.ceil(Math.sqrt(nodes.length));
                node.position({x: (i % step) * bounds.w / step,
                    y: Math.floor(i / step) * bounds.h / step});
            });
            separateLayoutNodes(nodes);
            if (--running === 0) done();
        });
        layout.run();
    }
}
