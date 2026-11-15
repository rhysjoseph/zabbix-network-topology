// Preserve the generated layout and move only nodes whose bodies or labels collide.
const CELL = 128;
const GAP = 12;
const BOUNDS = {includeLabels: true, includeOverlays: false, includeEdges: false};

export function separateLayoutNodes(nodes) {
    const visible = nodes.filter(':visible[!isGroup]');
    if (visible.length < 2) return;
    const locked = visible.filter(':locked');
    const movable = visible.not(':locked').toArray().sort((a, b) =>
        b.degree() - a.degree() || a.id().localeCompare(b.id()));
    const cells = new Map();
    let rightmost = -Infinity;
    const box = node => {
        const b = node.boundingBox(BOUNDS);
        if (![b.x1, b.x2, b.y1, b.y2].every(Number.isFinite)) return null;
        return {x1: b.x1 - GAP / 2, x2: b.x2 + GAP / 2, y1: b.y1 - GAP / 2, y2: b.y2 + GAP / 2};
    };

    function visitCells(b, visit) {
        for (let x = Math.floor(b.x1 / CELL); x <= Math.floor(b.x2 / CELL); x++) {
            for (let y = Math.floor(b.y1 / CELL); y <= Math.floor(b.y2 / CELL); y++) {
                visit(x + ',' + y);
            }
        }
    }

    function reserve(b) {
        visitCells(b, function(key) {
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(b);
        });
        rightmost = Math.max(rightmost, b.x2);
    }

    function collisions(b) {
        const hits = new Set();
        visitCells(b, function(key) {
            for (const other of cells.get(key) || []) {
                if (b.x1 < other.x2 && b.x2 > other.x1 && b.y1 < other.y2 && b.y2 > other.y1) {
                    hits.add(other);
                }
            }
        });
        return hits;
    }

    function translate(b, x, y) {
        return {x1: b.x1 + x, x2: b.x2 + x, y1: b.y1 + y, y2: b.y2 + y};
    }

    locked.forEach(function(node) {
        const b = box(node);
        if (b) reserve(b);
    });
    const moves = [];
    for (const node of movable) {
        const b = box(node);
        if (!b) continue;
        const hits = collisions(b);
        if (!hits.size) {
            reserve(b);
            continue;
        }

        // Try the nearest edge of the collision first. Then check nearby
        // positions in the same neighbourhood before extending the canvas.
        const offsets = [
            [Math.min(...Array.from(hits, h => h.x1 - b.x2)), 0],
            [Math.max(...Array.from(hits, h => h.x2 - b.x1)), 0],
            [0, Math.min(...Array.from(hits, h => h.y1 - b.y2))],
            [0, Math.max(...Array.from(hits, h => h.y2 - b.y1))]
        ];
        const step = Math.max(GAP, Math.min(b.x2 - b.x1, b.y2 - b.y1) / 2);
        for (let r = 1; r <= 4; r++) {
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                offsets.push([dx * r * step, dy * r * step]);
            }
        }
        offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
        const [dx, dy] = offsets.find(([x, y]) => !collisions(translate(b, x, y)).size)
            || [rightmost - b.x1, 0];
        reserve(translate(b, dx, dy));
        const p = node.position();
        moves.push([node, {x: p.x + dx, y: p.y + dy}]);
    }
    visible.cy().batch(function() {
        moves.forEach(([node, position]) => node.position(position));
    });
}

export function finishSpacedLayout(event) {
    const {eles, cy, fit, padding} = event.layout.options;
    if (cy.destroyed()) return;
    separateLayoutNodes(eles.nodes());
    if (fit) fitTopology(cy, eles, padding);
}

// The toolbar and fullscreen can resize the canvas after an initial fit.
// Recalculate the zoom floor from its current dimensions before fitting.
export function fitTopology(cy, elements = cy.nodes(), padding = 40) {
    const bounds = elements.boundingBox();
    const zoom = Math.min((cy.width() - 2 * padding) / bounds.w,
        (cy.height() - 2 * padding) / bounds.h);
    if (zoom > 0 && zoom < cy.minZoom()) cy.minZoom(zoom);
    cy.fit(elements, padding);
}
