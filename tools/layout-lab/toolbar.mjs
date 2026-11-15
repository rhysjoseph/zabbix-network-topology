// Compare the released toolbar and exercise the current one in the local lab.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = fileURLToPath(new URL('./fixture.py', import.meta.url));
const groups = JSON.parse(execFileSync('python3', [fixture, 'groups'], {encoding:'utf8'}));
const origin = 'http://127.0.0.1:18080';
const selection = ['Media Blue', 'Media Red', 'Routing', 'Utility'].map(
    name => '&groupids%5B%5D=' + encodeURIComponent(groups['Live Event/' + name])).join('');
const url = origin + '/zabbix.php?action=network.topology.view&apply=Apply&nt_tab=tech' + selection;
const tabs = ['tech', 'mgmt', 'tree', 'geo', 'plan', 'health', 'stats', 'lldpq', 'compliance', 'diag'];
const menus = {
    View: ['#nt-menu-view', '#nt-menu-view-pop'],
    Layout: ['#nt-menu-layout', '#nt-menu-layout-pop'],
    Tools: ['#nt-menu-tools', '#nt-menu-tools-pop'],
    Export: ['#nt-export-wrap > button', '#nt-export-wrap > div']
};
const buttons = [
    ...tabs.map(tab => '#nt-tab-' + tab),
    '#nt-btn-zoom-in', '#nt-btn-zoom-out',
    menus.View[0], menus.Layout[0], menus.Tools[0],
    ...['ghosts', 'bundle', 'auto', 'lldp', 'linkquality', 'rings', 'expected', 'nodesize',
        'collapse', 'undo', 'redo'].map(name => '#nt-btn-' + name),
    menus.Export[0]
];
const mac = '#nt-fdb-wrap > button';
const macPopup = '#nt-fdb-wrap > div';
const filter = '#nt-sev-filter button[data-sev="0"]';
const search = '#nt-search-input';

async function session(browser, width, tag) {
    const context = await browser.newContext({viewport:{width, height:949}});
    await context.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).origin !== origin) return route.abort();
        // Exercise layout history without replacing the lab's saved positions.
        if (request.method() === 'POST' && request.url().includes('action=network.topology.positions')) {
            return route.fulfill({json:{ok:true}});
        }
        return route.continue();
    });
    if (tag) {
        for (const [file, contentType] of [
            ['assets/js/dist/nt-bundle.js', 'application/javascript'],
            ['assets/css/network-topology.css', 'text/css']
        ]) {
            const content = execFileSync('git', ['show', tag + ':' + file]);
            await context.route(new RegExp('/' + file + '(?:\\?|$)'), route =>
                route.fulfill({body:content,contentType}));
        }
    }
    await context.addInitScript(() => {
        localStorage.setItem('nt_u1_group_cluster','colors');
        localStorage.setItem('nt_u1_layout','cose');
        localStorage.setItem('nt_u1_ghosts','off');
        localStorage.setItem('nt_u1_bundle','1');
        localStorage.setItem('nt_collapse_leaves','0');
    });
    const page = await context.newPage();
    await page.goto(origin+'/index.php');
    await page.locator('input[name=name]').fill('Admin');
    await page.locator('input[name=password]').fill('zabbix');
    await Promise.all([page.waitForURL(u => u.pathname !== '/index.php'),
        page.locator('button[type=submit],input[type=submit]').first().click()]);
    await page.goto(url);
    await page.waitForFunction(() => window._ntCy?.nodes().length === 31);
    await page.locator(menus.View[0]).click();
    await page.locator('#nt-btn-fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'nt-root');
    // Close View by clicking outside the popup before measuring the toolbar.
    await page.mouse.click(2, 4);
    await page.waitForFunction(() => !document.querySelector('#nt-menu-view-pop').offsetHeight);
    return page;
}

async function measure(page, selectors = buttons) {
    return page.evaluate(selectors => {
        const controls = selectors.map(selector => ({
            selector, node:document.querySelector(selector)
        }));
        controls.sort((a,b) => a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        return controls.map(({selector,node}) => {
            const b = node.getBoundingClientRect();
            const points = [[0.5,0.5],[0.12,0.12],[0.88,0.12],[0.12,0.88],[0.88,0.88]];
            return {selector, label:node.textContent.trim(), enabled:!node.disabled, width:b.width, height:b.height,
                bounds:[b.left,b.top,b.right,b.bottom],
                hits:points.map(([x,y]) => node.contains(document.elementFromPoint(
                    b.left + b.width*x, b.top + b.height*y)))};
        });
    },selectors);
}

async function popupState(page, name) {
    const [trigger,popup] = menus[name];
    const button = page.locator(trigger);
    await button.click();
    const contents = await page.locator(popup).evaluate(el => ({
        entries:[...el.children].filter(n=>n.getBoundingClientRect().height).map(n=>n.textContent.trim()),
        top:el.getBoundingClientRect().top,
        toolbarBottom:document.querySelector('.nt-topbar').getBoundingClientRect().bottom
    }));
    const hits = await measure(page);
    await button.click();
    return {contents,hits};
}

async function audit(page, strict) {
    const closed = await measure(page);
    const open = {};
    for (const name of Object.keys(menus)) open[name] = await popupState(page,name);
    const misses = rows => rows.filter(b => b.enabled && b.hits.includes(false)).map(b => b.selector);
    const blocked = Object.fromEntries([['Closed',misses(closed)],
        ...Object.entries(open).map(([name,row])=>[name,misses(row.hits)])]);
    if (strict) {
        for (const [name, list] of Object.entries(blocked)) assert.deepEqual(list,[],name);
        for (const {contents} of Object.values(open)) assert.ok(contents.top >= contents.toolbarBottom - 1);
        for (const b of closed) assert.ok(b.width>0 && b.height>0,b.selector);
        const extra = [mac,filter,search];
        await hit(page,mac,'center');
        assert.ok(await page.locator(macPopup).isVisible());
        assert.ok(await page.locator(macPopup).evaluate(el =>
            el.getBoundingClientRect().top >= document.querySelector('.nt-topbar').getBoundingClientRect().bottom));
        assert.deepEqual(misses(await measure(page,[...buttons,...extra])),[],'MAC menu open');
        await hit(page,mac,false);
        assert.ok(!await page.locator(macPopup).count());
    }
    return {closed,open,blocked};
}

// Use actual mouse clicks near the edge of the hit target. Several actions
// rebuild the graph, so obtain a fresh locator each time.
async function hit(page, selector, edge = true) {
    const button = page.locator(selector);
    const box = await button.boundingBox();
    assert.ok(box,selector);
    const click = edge === 'center' ? box.width/2 : edge ? box.width-4 : 4;
    await button.click({position:{x:click,y:box.height/2}});
}

async function exerciseLabels(page) {
    const zoom = () => page.evaluate(()=>window._ntCy.zoom());
    const zoomText = page.locator('#nt-zoom-label');
    const start = await zoom();
    await hit(page,'#nt-btn-zoom-in','center');
    const plus = await zoom();
    assert.ok(plus>start);
    assert.equal(await zoomText.textContent(),Math.round(plus*100)+'%');
    await hit(page,'#nt-btn-zoom-out','center');
    assert.ok(await zoom()<plus);
    assert.equal(await zoomText.textContent(),Math.round(await zoom()*100)+'%');

    for (const [trigger,popup] of [...Object.values(menus),[mac,macPopup]]) {
        const button = page.locator(trigger);
        await button.hover();
        assert.deepEqual(await button.evaluate(el => {
            const style = getComputedStyle(el);
            return [style.cursor,style.outlineStyle,style.opacity];
        }),['pointer','solid','1'],trigger);
        await hit(page,trigger,'center');
        assert.ok(await page.locator(popup).isVisible(),popup);
    }
    assert.ok(!await page.locator(menus.Export[1]).isVisible());
    assert.equal(await page.locator(mac).getAttribute('aria-expanded'),'true');
    assert.ok(await page.locator(macPopup+' input').evaluate(el=>el===document.activeElement));
    // MAC must release its popover when a graph rebuild replaces the toolbar.
    for (const name of ['ghosts','bundle','linkquality','rings','expected','nodesize','collapse']) {
        const selector = '#nt-btn-'+name;
        const before = await page.locator(selector).textContent();
        await hit(page,selector,'center');
        await page.waitForFunction(({selector,before})=>document.querySelector(selector)?.textContent!==before,
            {selector,before});
    }
    assert.ok(!await page.locator(macPopup).count());
    await hit(page,mac,'center');
    assert.ok(await page.locator(macPopup).isVisible());
    assert.equal(await page.locator(filter).evaluate(el=>el.style.background),'transparent');
    await hit(page,filter,'center');
    assert.notEqual(await page.locator(filter).evaluate(el=>el.style.background),'transparent');
    await hit(page,filter,false);
    assert.equal(await page.locator(filter).evaluate(el=>el.style.background),'transparent');
    await hit(page,search,'center');
    assert.ok(await page.locator(search).evaluate(el=>el===document.activeElement));
    await page.locator(search).pressSequentially('Utility Core');
    assert.ok(await page.evaluate(()=>window._ntCy.nodes().some(n=>n.style('opacity')==='0.15')));
    await page.locator(search).fill('');
}

async function exercise(page) {
    for (const tab of [...tabs.slice(1),'tech']) {
        // Keep a dropdown open so this also tests switching tabs through it.
        if (tab==='mgmt') await hit(page,menus.View[0]);
        await hit(page,'#nt-tab-'+tab);
        await page.waitForURL(u=>u.searchParams.get('nt_tab')===tab);
        assert.equal(await page.evaluate(()=>document.fullscreenElement?.id),'nt-root');
    }
    await page.waitForFunction(()=>window._ntCy?.nodes().length===31);
    const zoom = () => page.evaluate(()=>window._ntCy.zoom());
    const baseZoom = await zoom();
    await hit(page,'#nt-btn-zoom-in');
    assert.ok(await zoom()>baseZoom);
    const plusZoom = await zoom();
    await hit(page,'#nt-btn-zoom-out',false);
    assert.ok(await zoom()<plusZoom);

    for (const name of ['ghosts','bundle','auto','lldp','linkquality','rings','expected','nodesize','collapse']) {
        const selector = '#nt-btn-'+name;
        const before = await page.locator(selector).textContent();
        await hit(page,selector);
        await page.waitForFunction(({selector,before})=>document.querySelector(selector)?.textContent!==before,
            {selector,before});
        if (name==='lldp') assert.equal(await page.evaluate(()=>window._ntCy.edges('[?isLLDP]:visible').length),0);
        if (name==='collapse') assert.ok(await page.evaluate(()=>window._ntCy.nodes(':visible').length<31));
    }
    await hit(page,'#nt-btn-ghosts',false);
    await hit(page,'#nt-btn-bundle',false);
    await hit(page,'#nt-btn-lldp');
    await hit(page,'#nt-btn-collapse',false);
    await hit(page,menus.View[0]);
    await hit(page,'#nt-btn-labels',false);
    assert.match(await page.locator('#nt-btn-labels').textContent(),/Show Labels/);
    await hit(page,'#nt-btn-labels');
    await hit(page,menus.Tools[0]);
    await hit(page,'#nt-btn-snap',false);
    assert.ok(await page.locator('#nt-btn-snap-clear').isVisible());
    await hit(page,'#nt-btn-snap-clear');

    const coords = () => page.evaluate(()=>window._ntCy.nodes().map(n=>[n.id(),n.position('x'),n.position('y')]));
    // Leave the View menu open before switching to Layout, exercising the
    // menu-to-menu path. Layout history should restore actual node positions.
    await hit(page,menus.View[0]);
    await hit(page,menus.Layout[0]);
    await hit(page,'#nt-layout-wrap > button',false);
    const before = await coords();
    await page.locator('#nt-layout-wrap > div').getByText('Grid',{exact:true}).click();
    await page.waitForFunction(()=>localStorage.getItem('nt_u1_layout')==='grid');
    await page.waitForTimeout(1100); // wait for layout animation and its save callback
    const grid = await coords();
    assert.notDeepEqual(grid,before);
    await hit(page,'#nt-btn-undo',false);
    assert.deepEqual(await coords(),before);
    await hit(page,'#nt-btn-redo');
    assert.deepEqual(await coords(),grid);
    // A click on Export should both close Layout and reach Export.
    await hit(page,menus.Layout[0]);
    await hit(page,menus.Export[0]);
    await page.locator(menus.Export[1]).getByText('PNG').click();
    const preview = page.locator('#nt-root #nt-export-overlay');
    assert.ok(await preview.isVisible());
    await preview.click({position:{x:5,y:5}});
}

async function exerciseGroupOutlines(page) {
    const chooseLayout = async name => {
        const button = '#nt-layout-wrap > button';
        if (!await page.locator(button).isVisible()) await hit(page,menus.Layout[0],'center');
        await hit(page,button,'center');
        await page.locator('#nt-layout-wrap > div').getByText(name,{exact:true}).click();
    };
    const chooseCluster = async mode => {
        if (!await page.locator('#nt-btn-cluster').isVisible()) await hit(page,menus.Layout[0],'center');
        await hit(page,'#nt-btn-cluster','center');
        await page.locator(`#nt-cluster-wrap [data-mode="${mode}"]`).click();
    };
    const coloursVisible = async () => {
        const legend = page.locator('#nt-group-colour-legend');
        assert.ok(await legend.isVisible(),'the group colour legend should be visible');
        assert.equal(await legend.locator(':scope > span').count(),4);
        assert.match(await legend.textContent(),/Media Blue.*Media Red/);
        assert.equal(await page.locator('#nt-group-hulls').count(),0);
        const outlines = await page.evaluate(() => window._ntCy.nodes('.nt-group-colour').map(n => ({
            group:n.data('_primaryGroup'), colour:n.style('border-color'), width:n.numericStyle('border-width')
        })));
        assert.equal(outlines.length,31);
        assert.ok(outlines.every(n => n.width > 0));
        const colours = name => outlines.filter(n=>n.group.endsWith('/'+name))
            .map(n=>n.colour.replaceAll(' ',''));
        assert.deepEqual(colours('Media Blue'),Array(4).fill('rgb(59,130,246)'));
        assert.deepEqual(colours('Media Red'),Array(4).fill('rgb(239,68,68)'));
    };
    const visit = async tab => {
        await hit(page,'#nt-tab-'+tab,'center');
        await page.waitForURL(u=>u.searchParams.get('nt_tab')===tab);
    };

    await chooseLayout('Hierarchy');
    await chooseCluster('auto');
    await coloursVisible();
    for (const tab of ['tree','mgmt']) {
        await visit(tab);
        assert.equal(await page.locator('#nt-group-colour-legend').count(),0);
        await visit('tech');
        await coloursVisible();
    }

    // Picking Force packs the groups. Returning to Technical uses its saved
    // positions and should draw individual outlines without reclustering.
    const saved = page.waitForRequest(req=>req.method()==='POST'
        && req.url().includes('action=network.topology.positions'));
    await chooseLayout('Force');
    assert.equal(await page.locator('#nt-group-hulls > path').count(),4);
    assert.equal(await page.locator('#nt-group-colour-legend').count(),0);
    await saved;
    await visit('tree');
    await visit('tech');
    await coloursVisible();

    await chooseLayout('Force');
    assert.equal(await page.locator('#nt-group-hulls > path').count(),4);
    await chooseLayout('Hierarchy');
    await coloursVisible();
    await chooseCluster('off');
    assert.equal(await page.locator('#nt-group-hulls, #nt-group-colour-legend').count(),0);
    assert.equal(await page.evaluate(()=>window._ntCy.nodes('.nt-group-colour').length),0);
}

const browser = await chromium.launch({channel:'chrome',args:['--window-size=1512,949']});
try {
    const reports = {};
    for (const tag of ['v5.6.9','v5.6.10']) {
        const page = await session(browser,1512,tag);
        reports[tag] = await audit(page,false);
        console.log(tag,'blocked hit targets',reports[tag].blocked);
        await page.context().close();
    }
    for (const width of [1512,1180,620]) {
        const page = await session(browser,width);
        const errors = [];
        page.on('pageerror',err=>errors.push(err.message));
        reports[width] = await audit(page,true);
        const currentOrder = reports[width].closed.map(b=>b.selector);
        for (const tag of ['v5.6.9','v5.6.10']) {
            assert.deepEqual(currentOrder,reports[tag].closed.map(b=>b.selector));
            assert.deepEqual(reports[width].closed.map(({width,height})=>[width,height]),
                reports[tag].closed.map(({width,height})=>[width,height]));
            for (const menu of ['View','Export']) {
                assert.deepEqual(reports[width].open[menu].contents.entries,
                    reports[tag].open[menu].contents.entries);
            }
        }
        console.log(width,buttons.length,'released controls verified with menus open and closed');
        if (width===1512) {
            await exercise(page);
            await exerciseGroupOutlines(page);
        }
        // Exercise label clicks with fresh preferences, independently of layout history.
        if (width===1180 || width===620) await exerciseLabels(page);
        assert.deepEqual(errors,[]);
        await page.context().close();
    }
    const report = process.argv[2] || '/private/tmp/nt-toolbar-audit.json';
    writeFileSync(report, JSON.stringify(reports,null,2));
    console.log('Fullscreen padding and label clicks verified. Hit-area report:', report);
} finally {
    await browser.close();
}
