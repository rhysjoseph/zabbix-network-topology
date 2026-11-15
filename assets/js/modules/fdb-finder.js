// fdb-finder.js — „an welchem Port haengt diese MAC?" als kleines Panel.
//
// Ein Toolbar-Knopf oeffnet ein schwebendes Panel mit einem Eingabefeld; die
// Suche ruft die Action network.topology.fdb_search und zeigt den Zugangsport,
// ehrlich ueber Mehrdeutigkeit und Alter. Kein Dauertab — die Suche ist ein
// punktueller Lookup, und die Tableiste ist voll.
//
// SICHERHEIT: Switch-Namen und Portnamen kommen vom Geraet, nicht von uns —
// jede dynamische Zeichenkette geht ueber el()/textContent, nie ueber innerHTML.
//
// FARBEN: das Panel haengt in der Toolbar (innerhalb #nt-root), die Token loesen
// also auf; nt-dark wird beim Oeffnen gesetzt, damit es dem Theme folgt.

import { el, isDark, paintAdaptive } from './utils.js';
import { fetchJson } from './http.js';
import { meta as qualiMeta, QUALITY, classify } from './quality.js';
import { t } from './i18n.js';
import { closeToolbarPopover, toggleToolbarPopover } from './toolbar-popover.js';

// FDB altert (~300 s) und wird alle paar Minuten geholt: aelter als das hier
// heisst „nicht mehr frisch gemessen".
const FDB_STALE_S = 900;

let _panel = null;

/** URL der FDB-Suche aus der Data-URL ableiten (wie edge-detail fuer spark). */
function searchUrl(mac) {
    const cfg = window.NT_CONFIG || {};
    const base = (cfg.data_url || '').replace('network.topology.data', 'network.topology.fdb_search');
    return base + '&mac=' + encodeURIComponent(mac);
}

function agoText(ts) {
    if (!ts) {
        return t('fdb.ago.unknown');
    }
    const sec = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (sec < 60)    return t('detail.ago', { v: sec + 's' });
    if (sec < 3600)  return t('detail.ago', { v: Math.floor(sec / 60) + 'm' });
    if (sec < 86400) return t('detail.ago', { v: Math.floor(sec / 3600) + 'h' });
    return t('detail.ago', { v: Math.floor(sec / 86400) + 'd' });
}

/** Kleiner Zeit-Chip in der Guete-Farbe: frisch gemessen vs. veraltet. */
function tsChip(ts) {
    const state = ts ? classify(1, { stale: (Math.floor(Date.now() / 1000) - ts) > FDB_STALE_S })
                     : QUALITY.UNKNOWN;
    const m = qualiMeta(state);
    return el('span', 'font-size:10px;color:' + m.cssVar + ';white-space:nowrap',
        m.glyph + ' ' + agoText(ts));
}

function hostName(data, hid) {
    const names = data.host_names || {};
    return (names && names[hid]) ? String(names[hid]) : String(hid);
}

/** Eine Fundort-Zeile: Switch · Port · (VLAN) · Zeit-Chip. */
function hitRow(data, h, strong) {
    const row = el('div', 'display:flex;align-items:center;gap:8px;'
        + 'padding:4px 0;font-size:12px;' + (strong ? 'font-weight:600' : ''));
    row.appendChild(el('span', 'color:var(--nt-text)', hostName(data, h.hostid)));
    row.appendChild(el('span', 'color:var(--nt-muted)', t('fdb.port')));
    row.appendChild(el('span', 'color:var(--nt-text);font-family:monospace', String(h.port)));
    if (h.vlan !== null && h.vlan !== undefined) {
        row.appendChild(el('span', 'color:var(--nt-muted);font-size:10px', 'VLAN ' + String(h.vlan)));
    }
    const sp = el('span', 'margin-left:auto');
    sp.appendChild(tsChip(h.ts || 0));
    row.appendChild(sp);
    return row;
}

function renderResult(data, box) {
    box.textContent = '';

    // Kopfzeile: Status als ein Satz.
    const headKey = {
        access: 'fdb.status.access', ambiguous: 'fdb.status.ambiguous',
        uplink_only: 'fdb.status.uplink_only', no_lldp: 'fdb.status.no_lldp',
        not_found: 'fdb.status.not_found', invalid: 'fdb.status.invalid',
        arp_not_found: 'fdb.status.arp_not_found',
    }[data.status] || 'fdb.status.not_found';
    const good = data.status === 'access';
    const warn = data.status === 'ambiguous' || data.status === 'uplink_only'
              || data.status === 'no_lldp';
    const headColor = good ? 'var(--nt-ok-text)' : (warn ? 'var(--nt-warn-text)' : 'var(--nt-muted)');
    box.appendChild(el('div', 'font-weight:700;font-size:12px;margin-bottom:2px;color:' + headColor,
        (good ? '✓ ' : (warn ? '⚠ ' : '')) + t(headKey)));
    // IP-Suche: zeigen, WIE die IP zur MAC wurde — IP -> MAC, laut welchem
    // Router und wie frisch der ARP-Eintrag ist. Namen/MAC sind Geraetedaten,
    // also ueber el()/textContent.
    if (data.query_kind === 'ip' && data.resolved_mac) {
        const arp = el('div', 'font-size:11px;margin-bottom:2px;color:var(--nt-text)');
        arp.appendChild(el('span', 'font-family:monospace', String(data.query)));
        arp.appendChild(el('span', 'color:var(--nt-muted);margin:0 6px', '→'));
        arp.appendChild(el('span', 'font-family:monospace', String(data.resolved_mac)));
        box.appendChild(arp);
        const via = el('div', 'font-size:10px;color:var(--nt-muted);margin-bottom:6px;'
            + 'display:flex;align-items:center;gap:6px');
        if (data.arp_src === 'eui64') {
            // Aus der IPv6 selbst gerechnet (EUI-64) — kein Router, kein Alter.
            via.appendChild(el('span', '', t('fdb.arp.eui64')));
        }
        else {
            via.appendChild(el('span', '', t('fdb.arp.via', { host: String(data.arp_host || '') })));
            via.appendChild(tsChip(data.arp_ts || 0));
        }
        box.appendChild(via);
    }
    else if (data.query_kind === 'ip') {
        // IP ohne ARP-Treffer: wenigstens die gesuchte IP zeigen.
        box.appendChild(el('div', 'font-family:monospace;font-size:11px;color:var(--nt-muted);margin-bottom:6px',
            String(data.query || '')));
    }
    else if (data.mac) {
        box.appendChild(el('div', 'font-family:monospace;font-size:11px;color:var(--nt-muted);margin-bottom:6px',
            String(data.mac)));
    }

    // Der/die Zugangsport(e) prominent.
    if (data.access && data.access.length) {
        data.access.forEach(function(h) { box.appendChild(hitRow(data, h, true)); });
    }

    // Alle Fundorte (inkl. Uplinks) — der Kontext, warum die Antwort so lautet.
    // Nach Host|Port deduplizieren: dieselbe MAC auf demselben Uplink-Port in
    // zwei VLANs (dot1q) ist EIN Ort, nicht zwei — sonst steht der Uplink doppelt.
    const restSeen = {};
    const rest = (data.all || []).filter(function(h) {
        const inAccess = (data.access || []).some(function(a) {
            return a.hostid === h.hostid && a.port === h.port;
        });
        if (inAccess) {
            return false;
        }
        const k = h.hostid + '|' + h.port;
        if (restSeen[k]) {
            return false;
        }
        restSeen[k] = true;
        return true;
    });
    if (rest.length) {
        box.appendChild(el('div', 'margin-top:8px;font-size:10px;font-weight:700;'
            + 'text-transform:uppercase;letter-spacing:0.05em;color:var(--nt-muted)',
            t('fdb.all')));
        rest.forEach(function(h) {
            const row = hitRow(data, h, false);
            row.appendChild(el('span', 'font-size:9px;color:var(--nt-muted);margin-left:6px',
                t('fdb.kind.' + (h.kind || 'unknown'))));
            box.appendChild(row);
        });
    }

    // Methoden-Hinweis: wurde der Treffer per LLDP klassifiziert (verlaesslich),
    // steht das kurz da; beruht er auf der MAC-Zahl-Heuristik, die ehrliche
    // Warnung, dass ein Hypervisor-/Downstream-Port wie ein Uplink aussieht.
    if (data.status !== 'invalid' && data.status !== 'not_found'
            && data.status !== 'arp_not_found') {
        const key = data.method === 'fdb-lldp' ? 'fdb.method.lldp' : 'fdb.method';
        box.appendChild(el('div', 'margin-top:8px;font-size:10px;color:var(--nt-muted);'
            + 'border-top:1px solid var(--nt-line-soft);padding-top:6px', t(key)));
    }
}

function doSearch(mac, box) {
    box.textContent = '';
    box.appendChild(el('div', 'font-size:12px;color:var(--nt-muted)', t('fdb.searching')));
    fetchJson(searchUrl(mac)).then(function(data) {
        if (_panel && _panel.contains(box)) {
            renderResult(data || {}, box);
        }
    }).catch(function(e) {
        if (_panel && _panel.contains(box)) {
            box.textContent = '';
            box.appendChild(el('div', 'font-size:12px;color:var(--nt-warn-text)',
                t('fdb.error') + (e && e.message ? ' — ' + e.message : '')));
        }
    });
}

function openPanel(wrap, trigger) {
    const p = el('div', 'position:absolute;top:100%;right:0;z-index:9999;margin-top:4px;'
        + 'width:340px;max-height:60vh;overflow:auto;'
        + 'background:var(--nt-surface);border:1px solid var(--nt-line);border-radius:8px;'
        + 'box-shadow:var(--nt-shadow);padding:12px;color:var(--nt-text)');
    p.classList.toggle('nt-dark', isDark());
    paintAdaptive(p);
    p.addEventListener('click', function(e) { e.stopPropagation(); });

    p.appendChild(el('div', 'font-weight:700;font-size:12px;margin-bottom:8px', t('fdb.title')));

    const form = el('div', 'display:flex;gap:6px;margin-bottom:4px');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('fdb.placeholder');
    input.style.cssText = 'flex:1;min-width:0;padding:6px 8px;font-size:12px;font-family:monospace;'
        + 'border:1px solid var(--nt-line);border-radius:6px;'
        + 'background:var(--nt-surface);color:var(--nt-text)';
    const btn = document.createElement('button');
    btn.className = 'btn-alt btn-small';
    btn.style.margin = '0';
    btn.textContent = t('fdb.find');
    form.appendChild(input);
    form.appendChild(btn);
    p.appendChild(form);

    const box = el('div', 'margin-top:8px');
    p.appendChild(box);

    const run = function() {
        const mac = input.value.trim();
        if (mac !== '') {
            doSearch(mac, box);
        }
    };
    btn.addEventListener('click', run);
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            run();
        }
    });

    wrap.appendChild(p);
    _panel = p;
    toggleToolbarPopover(trigger, p, function() {
        _panel = null;
        p.remove();
    });
    input.focus({preventScroll: true});
}

/**
 * Baut den „MAC"-Knopf in die Toolbar (bar). Idempotent wie setupExportMenu:
 * ein vorhandenes Wrap wird vor dem Neu-Anlegen entfernt.
 */
export function setupFdbFinder(bar, isFirstRun) {
    const existing = document.getElementById('nt-fdb-wrap');
    if (existing) {
        if (_panel && existing.contains(_panel)) closeToolbarPopover();
        existing.remove();
    }
    const wrap = el('div', 'position:relative;display:inline-block;margin-left:4px');
    wrap.id = 'nt-fdb-wrap';

    const btn = document.createElement('button');
    btn.className = 'btn-alt btn-small';
    btn.style.margin = '0';
    btn.textContent = '\u{1F50E} ' + t('fdb.button');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (_panel) {
            closeToolbarPopover();
        }
        else {
            openPanel(wrap, btn);
        }
    });

    wrap.appendChild(btn);
    if (bar && isFirstRun) {
        bar.appendChild(wrap);
    }
}
