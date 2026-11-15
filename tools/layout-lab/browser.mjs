// Run with PLAYWRIGHT_MODULE pointing to a locally installed Playwright.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const origin = 'http://127.0.0.1:18080';
const script = fileURLToPath(new URL('./fixture.py', import.meta.url));
const run = action => execFileSync('python3', [script, action], {encoding: 'utf8'}).trim();
const groups = JSON.parse(run('groups'));
const isRecorder = 'Temporary-Recorder';
const output = resolve(process.argv[2] || '/private/tmp/nt-layout-results');
mkdirSync(output, {recursive:true});
const errors = [];
const writes = [];
const samples = {};
const open = (p, ...groups) => p.goto(origin + '/zabbix.php?action=network.topology.view&apply=Apply&nt_tab=tech' +
    groups.map(g => '&groupids%5B%5D=' + encodeURIComponent(g)).join(''));
const stable = async p => {
    await p.waitForFunction(() => window._ntCy && window._ntCy.nodes().length >= 5);
    await p.waitForTimeout(1300); // settle layout animation and deferred fit
};

async function session(browser, settings, viewport = {width: 1512, height: 1000}, baseline = false) {
    const context = await browser.newContext({viewport});
    await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    if (baseline) {
        const bundle = readFileSync(process.env.NT_BASELINE_BUNDLE);
        await context.route('**/nt-bundle.js*', r =>
            r.fulfill({body:bundle, contentType:'application/javascript'}));
    }
    await context.addInitScript(prefs => {
        localStorage.setItem('nt_collapse_leaves','0');
        for (const [key, value] of Object.entries(prefs)) localStorage.setItem('nt_u1_' + key, value);
    }, { nodesize:'klein', bundle:'1', ghosts:'all', group_view:'0', ...settings });
    const p = await context.newPage();
    p.on('pageerror', err => errors.push(err.message));
    p.on('request', req => {
        if (req.url().includes('action=network.topology.positions') && req.method() === 'POST') writes.push(req);
    });
    await p.goto(origin + '/index.php');
    await p.locator('input[name=name]').fill('Admin');
    await p.locator('input[name=password]').fill('zabbix');
    await Promise.all([p.waitForURL(url => url.pathname !== '/index.php'),
        p.locator('button[type=submit],input[type=submit]').first().click()]);
    return p;
}

async function clearLabView(page) {
    await open(page,groups.Event);
    const result = await page.evaluate(async group => {
        const c = window.NT_CONFIG;
        const positions = c.positions.shared;
        if (!Object.prototype.hasOwnProperty.call(positions,group)) return {ok:true};
        delete positions[group];
        const form = new URLSearchParams({scope:'shared', nt_csrf:c.positions_csrf,
            positions:JSON.stringify(positions), base:c.revisions.positions_shared});
        return (await fetch(c.positions_url,{method:'POST',body:form,
            headers:{'X-Requested-With':'XMLHttpRequest'}})).json();
    },groups.Event);
    assert.ok(result.ok, JSON.stringify(result));
}

async function capture(p, key) {
    const result = await p.evaluate(() => {
        const cy = window._ntCy;
        const list = cy.nodes(':visible[!isGroup]').map(n => ({
            id:n.id(), label:n.data('label'), host:n.data('host') || '',
            x:n.position('x'), y:n.position('y'),
            bundle:!!n.data('_isEndpointBundle'), ghost:!!n.data('_isGhost'),
            group:n.data('_primaryGroup') || '', colour:n.data('groupColour') || '',
            box:n.boundingBox({includeLabels:true, includeOverlays:false})
        }));
        const keep = new Set(list.map(n => n.id));
        const edges = cy.edges(':visible').map(e => [e.source().id(), e.target().id(), !!e.data('_isStaleEdge')])
            .filter(([a,b]) => keep.has(a) && keep.has(b));
        return {nodes:list, edges, pan:cy.pan(), zoom:cy.zoom(),
            width:cy.width(), height:cy.height(), at:window._ntLastData.snapshot_at,
            tierById:Object.fromEntries(window._ntLastData.nodes.map(n => [n.id,n.layout_tier]))};
    });
    const overlaps = (a,b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
    let overlap = 0;
    for (const [i, n] of result.nodes.entries()) {
        for (const m of result.nodes.slice(i+1)) if (overlaps(n.box,m.box)) overlap++;
    }
    const byId = new Map(result.nodes.map(n => [n.id,n]));
    function sign(a,b,c) { return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x); }
    let crossings = 0;
    for (const [i,[a,b]] of result.edges.entries()) {
        for (const [c,d] of result.edges.slice(i+1)) {
            if (new Set([a,b,c,d]).size < 4) continue;
            const [A,B,C,D] = [a,b,c,d].map(id => byId.get(id));
            if (sign(A,B,C)*sign(A,B,D) < 0 && sign(C,D,A)*sign(C,D,B) < 0) crossings++;
        }
    }
    samples[key] = {...result, overlap, crossings};
    console.log(key, JSON.stringify({visible:result.nodes.length, links:result.edges.length, overlap, crossings,
        bundles:result.nodes.filter(n => n.bundle).length, at:result.at}));
    const canvas = p.locator('#nt-canvas-wrap');
    if (await canvas.count()) await canvas.screenshot({path:resolve(output, key+'.png')});
    writeFileSync(resolve(output, 'samples.json'), JSON.stringify(samples));
    return result;
}

const viewState = p => p.evaluate(() => {
    const cy = window._ntCy;
    const n = cy.nodes().filter(n => n.data('label') === 'Event Core').first();
    return {point:{...n.position()}, pan:{...cy.pan()}, zoom:cy.zoom(), id:n.id(),
        url:location.href};
});
const getFollowResponse = p => p.waitForResponse(r =>
    r.url().includes('action=network.topology.positions') && r.request().method() === 'GET');
const toggleFollow = async p => {
    const button = p.locator('#nt-btn-follow-layout');
    if (!await button.isVisible()) await p.locator('#nt-menu-layout').click();
    await button.click();
};
const changeCluster = async (p, mode) => {
    const button = p.locator('#nt-btn-cluster');
    if (!await button.isVisible()) await p.locator('#nt-menu-layout').click();
    await button.click();
    await p.locator('#nt-cluster-wrap [data-mode="'+mode+'"]').click();
};

async function checkGroups(browser) {
    const settings = {layout:'cose', group_cluster:'rows', ghosts:'off'};
    const sites = ['North/Utility','North/Media 2110','South/Utility','South/Media 2110'];
    const roomGroups = ['Control Room','Machine Room'].map(name => groups[name]);
    const siteGroups = sites.map(name => groups[name]);
    const networks = ['Utility','Media 2110'].map(name => groups[name]);
    const page = await session(browser, settings, {width:1150,height:760});
    const checkPacked = (sample, mode, count, groupCount) => {
        assert.equal(sample.nodes.length,count);
        const bounds = new Map();
        const {pan,zoom,width,height} = sample;
        const min = mode === 'rows' ? 'y1' : 'x1';
        const max = mode === 'rows' ? 'y2' : 'x2';
        for (const {group,box} of sample.nodes) {
            assert.ok(box.x1*zoom+pan.x >= 0 && box.x2*zoom+pan.x <= width &&
                box.y1*zoom+pan.y >= 0 && box.y2*zoom+pan.y <= height,'Fit frames every node and label');
            const previous = bounds.get(group) || [Infinity,-Infinity];
            bounds.set(group,[Math.min(previous[0],box[min]), Math.max(previous[1],box[max])]);
        }
        assert.equal(bounds.size,groupCount);
        const sorted = [...bounds.values()].sort((a,b) => a[0]-b[0]);
        for (let i=1;i<sorted.length;i++) {
            assert.ok(sorted[i][0]-sorted[i-1][1] >= 145,'Group spacing survives fitting');
        }
    };
    if (process.env.NT_BASELINE_BUNDLE) {
        const baseline = await session(browser, settings, {width:1150,height:760}, true);
        await open(baseline,...siteGroups);
        await stable(baseline);
        await capture(baseline,'sites-rows-before');
        await baseline.context().close();
    }
    await open(page,...roomGroups);
    await stable(page);
    checkPacked(await capture(page,'rooms-rows'),'rows',12,2);
    await changeCluster(page,'columns');
    await stable(page);
    checkPacked(await capture(page,'rooms-columns'),'columns',12,2);

    await open(page,...siteGroups);
    await stable(page);
    await page.waitForFunction(() => window._ntCy.nodes().length >= 104);
    checkPacked(await capture(page,'sites-rows'),'rows',104,4);
    await changeCluster(page,'columns');
    await stable(page);
    checkPacked(await capture(page,'sites-columns'),'columns',104,4);

    await open(page,...networks);
    await stable(page);
    await changeCluster(page,'off');
    await stable(page);
    await page.evaluate(() => {window.layoutBeforeColours=window._ntCy;});
    const plain = await capture(page,'networks-off');
    await changeCluster(page,'colors');
    await page.waitForFunction(() => window._ntCy.nodes('.nt-group-colour').length === 104);
    assert.equal(await page.evaluate(() => window.layoutBeforeColours === window._ntCy),true);
    const coloured = await capture(page,'networks-colours');
    assert.deepEqual(coloured.nodes.map(n=>[n.id,n.x,n.y]),plain.nodes.map(n=>[n.id,n.x,n.y]));
    assert.deepEqual(coloured.pan,plain.pan);
    assert.equal(coloured.zoom,plain.zoom);
    assert.equal(new Set(coloured.nodes.map(n=>n.colour)).size,2);
    assert.equal(await page.locator('#nt-group-hulls').count(),0);
    const legend = await page.locator('#nt-group-colour-legend').textContent();
    assert.ok(legend.includes('Utility') && legend.includes('Media 2110'));
    const studio = ['Studio/Media Red','Studio/Media Blue','Studio/Utility'].map(name=>groups[name]);
    const checkEncoder = async (key, domains) => {
        await stable(page);
        const endpoint = await page.evaluate(() => {
            const matches = window._ntCy.nodes().filter(n => n.data('label') === 'Studio Encoder');
            const n = matches.first();
            return {count:matches.length, groups:n.data('_connectedGroups'), anchor:n.data('_sharedAfter'),
                peers:n.connectedEdges().map(e => e.source().id() === n.id()
                    ? e.target().data('label') : e.source().data('label')).sort()};
        });
        assert.equal(endpoint.count,1);
        assert.equal(endpoint.groups.length,domains);
        assert.ok(endpoint.anchor);
        assert.deepEqual(endpoint.peers,['Media Blue Edge','Media Red Edge','Utility Edge']);
        assert.match(await page.locator('#nt-group-hulls').textContent(),/Shared endpoints/);
        await capture(page,key);
    };
    await open(page,...studio);
    await checkEncoder('studio-red-blue-utility',3);
    await open(page,groups['Studio/Media 2110'],groups['Studio/Utility']);
    await checkEncoder('studio-media-and-utility',2);
    await changeCluster(page,'off');
    await stable(page);
    await changeCluster(page,'colors');
    assert.equal(await page.evaluate(() => window._ntCy.nodes('.nt-shared-endpoint').length),1);
    assert.match(await page.locator('#nt-group-colour-legend').textContent(),/Shared endpoints/);
    await capture(page,'studio-colours');
    console.log('Three-port encoder appears once with all three physical edges. It remains shared when Red and Blue roll up under Media 2110.');

    await page.context().close();
    console.log('Rows and columns preserved model-space separation on room and multi-site maps. Colours kept the same canvas, coordinates, pan and zoom.');
}

async function checkFollowPermissions(browser, editor, id) {
    const adminRequest = editor.context().request;
    let token;
    async function api(method, params) {
        const reply = await adminRequest.post(origin+'/api_jsonrpc.php', {
            headers: {'Content-Type':'application/json-rpc', ...(token ? {Authorization:'Bearer '+token} : {})},
            data: {jsonrpc:'2.0', id:1, method, params}
        });
        const body = await reply.json();
        assert.ok(!body.error, method+': '+JSON.stringify(body.error));
        return body.result;
    }
    token = await api('user.login', {username:'Admin',password:'zabbix'});
    const [role] = await api('role.get',{filter:{type:1},output:['roleid']});
    const name = 'nt-follow-reader-' + Date.now();
    const password = 'DockerLayout!Local-Only-2026';
    const rights = [{id:groups.Event,permission:2}];
    const {usrgrpids:[group]} = await api('usergroup.create',{name,hostgroup_rights:rights});
    let context, user;
    try {
        ({userids:[user]} = await api('user.create',{
            username:name, passwd:password, roleid:role.roleid, usrgrps:[{usrgrpid:group}]
        }));
        context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(origin+'/index.php');
        await page.locator('input[name=name]').fill(name);
        await page.locator('input[name=password]').fill(password);
        await Promise.all([page.waitForURL(url => url.pathname !== '/index.php'),
            page.locator('button[type=submit],input[type=submit]').first().click()]);
        const url = origin+'/zabbix.php?action=network.topology.positions&view='+groups.Event;
        const headers = {'X-Requested-With':'XMLHttpRequest'};
        const readable = await (await context.request.get(url,{headers})).json();
        assert.ok(readable.positions?.[id],'Reader with access can follow shared positions');
        await api('usergroup.update',{usrgrpid:group,hostgroup_rights:[]});
        const revoked = await (await context.request.get(url+'&since='+readable.revision,{headers})).json();
        assert.deepEqual(revoked.positions,{});
        assert.notEqual(revoked.revision,readable.revision);
        console.log('A read-only user received permitted positions and no coordinates after access was revoked.');
    } finally {
        if (context) await context.close();
        if (user) await api('user.delete',[user]);
        await api('usergroup.delete',[group]);
        await api('user.logout',[]);
    }
}

const chrome = await chromium.launch({channel:'chrome'});
let ff, force;
try {
    await checkGroups(chrome);
    const clustered = await session(chrome, {layout:'cose', group_cluster:'auto'});
    force = await session(chrome, {layout:'cose', group_cluster:'off'});
    const hierarchy = await session(chrome, {layout:'hierarchy', group_cluster:'auto'});
    const unbundled = await session(chrome, {layout:'cose', group_cluster:'off', bundle:'0'});
    run('restore');
    await clearLabView(force);
    await force.waitForFunction(() => {
        const cy = window._ntCy;
        return cy?.edges().some(e => !e.data('_isStaleEdge') &&
            [e.source().data('label'), e.target().data('label')].sort().join('|')
            === 'Control Access|Event Core');
    }, {}, {timeout:80000});
    writes.length = 0;
    for (const [p, key, ids] of [
        [clustered, 'fabric-groups', [groups['Fabric A'],groups['Fabric B']]],
        [force, 'fabric-force', [groups['Fabric A'],groups['Fabric B']]],
        [hierarchy, 'fabric-hierarchy-multi', [groups['Fabric A'],groups['Fabric B']]],
        [hierarchy, 'fabric-hierarchy-single', [groups.Fabric]],
        [unbundled, 'event-unbundled', [groups.Event]],
        [force, 'event-force', [groups.Event]],
        [hierarchy, 'event-hierarchy', [groups.Event]]
    ]) {
        await open(p, ...ids);
        await stable(p);
        await capture(p, key);
    }
    const coords = (sample, onlyReal = false) => Object.fromEntries(sample.nodes
        .filter(n => !onlyReal || n.host.startsWith('nt-layout-lab-')).map(n => [n.id,[n.x,n.y]]));
    const single = samples['fabric-hierarchy-single'];
    const multi = samples['fabric-hierarchy-multi'];
    assert.deepEqual(coords(single), coords(multi));
    const y = (s, role) => s.nodes.find(n => s.tierById[n.id] === role).y;
    assert.ok(y(single,'spine') < y(single,'leaf') && y(single,'leaf') < y(single,'access'));
    assert.ok(samples['event-force'].nodes.length < samples['event-unbundled'].nodes.length);
    assert.equal(writes.length, 0, 'Passive visits must never write layout');

    // The kiosk opens before the editor saves positions. Use a separate
    // browser engine and session to rule out same-origin storage messaging.
    ff = await firefox.launch();
    const viewer = await session(ff,{layout:'cose', group_cluster:'off'}, {width:1280,height:800});
    await open(viewer, groups.Event);
    await stable(viewer);
    assert.equal(await viewer.locator('#nt-btn-follow-layout').getAttribute('aria-pressed'),'false');
    await viewer.evaluate(() => {
        const cy = window._ntCy;
        window.kioskCanvas = cy;
        window.kioskPage = {};
        cy.zoom(0.8);
        cy.pan({x:144,y:89});
    });
    const kioskBefore = await viewState(viewer);
    const firstPoll = getFollowResponse(viewer);
    await toggleFollow(viewer);
    const first = await (await firstPoll).json();
    assert.equal(first.ok,true);
    assert.deepEqual(first.positions,{});
    assert.equal(await viewer.evaluate(() => window._ntCy.autoungrabify()),true);


    // Drag an actual node on the canvas. The second browser starts with a
    // separate cookie jar, storage, dimensions and a different engine.
    const node = await force.evaluate(() => {
        const cy = window._ntCy;
        const n = cy.nodes().filter(n => n.data('label') === 'Event Core').first();
        const rect = cy.container().getBoundingClientRect();
        const p = n.renderedPosition();
        return {id:n.id(), x:p.x+rect.left, y:p.y+rect.top};
    });
    const followed = viewer.waitForResponse(async r => {
        if (!r.url().includes('action=network.topology.positions') || r.request().method() !== 'GET') return false;
        const d = await r.json();
        return !!d.positions?.[node.id];
    });
    const saved = force.waitForResponse(r => r.url().includes('action=network.topology.positions') &&
        r.request().method() === 'POST', {timeout:8000});
    await force.mouse.move(node.x,node.y);
    await force.mouse.down();
    await force.mouse.move(node.x+78,node.y+82,{steps:10});
    await force.mouse.up();
    const response = await (await saved).json();
    assert.ok(response.ok, JSON.stringify(response));
    await force.evaluate(() => {
        const cy = window._ntCy;
        cy.zoom(cy.zoom() * 1.1);
        cy.panBy({x:25,y:15});
    });
    const edited = await capture(force,'event-edited');
    assert.notDeepEqual(coords(edited)[node.id], coords(samples['event-force'])[node.id]);

    const changed = await (await followed).json();
    assert.ok(changed.positions?.[node.id],JSON.stringify(changed));
    const savedPoint = changed.positions[node.id];
    await viewer.waitForFunction(({id,p}) => {
        const node = window._ntCy.getElementById(id);
        return node.position('x') === p.x && node.position('y') === p.y;
    },{id:node.id,p:savedPoint});
    const kioskAfter = await viewState(viewer);
    assert.deepEqual(kioskAfter.pan,kioskBefore.pan);
    assert.equal(kioskAfter.zoom,kioskBefore.zoom);
    assert.equal(kioskAfter.url,kioskBefore.url);
    assert.equal(await viewer.evaluate(() => window.kioskCanvas === window._ntCy && !!window.kioskPage),true);
    assert.equal(writes.length,1,'Only the editor may write coordinates');
    const unchanged = await (await getFollowResponse(viewer)).json();
    assert.deepEqual(unchanged,{ok:true, revision:changed.revision});
    await toggleFollow(viewer);
    assert.equal(await viewer.evaluate(() => window._ntCy.autoungrabify()),false);
    console.log('Already-open Firefox followed a Chrome drag without reloading, fitting, or writing. Unchanged poll returned only the revision.');

    await checkFollowPermissions(chrome,force,node.id);
    await viewer.reload();
    await stable(viewer);
    const other = await capture(viewer,'event-other-browser');
    for (const [id,xy] of Object.entries(coords(edited,true))) {
        const actual = coords(other,true)[id];
        assert.ok(actual && Math.round(xy[0]) === actual[0] && Math.round(xy[1]) === actual[1],
            `Saved coordinates differed on Firefox for ${id}: ${actual} vs ${xy}`);
    }
    console.log('Firefox loaded the same saved host positions with a different viewport and isolated browser storage.');

    // Stage new SNMP-equivalent readings and let the normal refresh timer
    // discover the change, without reload, tab switch or refresh click.
    const beforeWrites = writes.length;
    const ticks = [];
    force.on('response', r => { if (r.url().includes('action=network.topology.data')) ticks.push(r.status()); });
    const hasControlCable = (graph, stale = false) => {
        const ids = graph.nodes.filter(n => n.label === 'Control Access' || n.label === 'Event Core')
            .map(n => n.id);
        return ids.length === 2 && graph.edges.some(([a,b,s]) => s === stale &&
            [a,b].includes(ids[0]) && [a,b].includes(ids[1]));
    };
    assert.ok(hasControlCable(edited));
    run('move');
    await force.waitForFunction(name =>
        window._ntCy?.nodes().some(n => n.data('label') === name),
        isRecorder, {timeout:80000});
    await force.waitForTimeout(1000);
    const after = await capture(force,'event-lldp-change');
    const real = coords(edited,true);
    for (const [id,xy] of Object.entries(real)) assert.deepEqual(coords(after,true)[id],xy);
    assert.deepEqual(after.pan, edited.pan);
    assert.equal(after.zoom, edited.zoom);
    assert.ok(!hasControlCable(after) && hasControlCable(after,true));
    assert.equal(writes.length, beforeWrites);
    assert.ok(ticks.includes(200));
    console.log('Auto-refresh applied the LLDP change with all monitored host positions, pan and zoom unchanged.');

    run('restore');
    await force.waitForFunction(name =>
        !window._ntCy?.nodes().some(n => n.data('label') === name),
        isRecorder, {timeout:75000});
    const restored = await capture(force,'event-lldp-restored');
    assert.ok(hasControlCable(restored));
    assert.deepEqual(coords(restored,true),real);
    assert.deepEqual(restored.pan, edited.pan);
    assert.equal(restored.zoom, edited.zoom);
    assert.deepEqual(errors, []);
    console.log('LLDP recovery restored the measured edge without moving any monitored host.');
} finally {
    console.log(run('restore'));
    if (force) await clearLabView(force);
    await Promise.allSettled([chrome.close(), ff?.close()]);
}
