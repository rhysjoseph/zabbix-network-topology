<?php
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PlaNet Fox / Alexander Fox
declare(strict_types = 1);

namespace Modules\NetworkTopology\Actions;

use CCsrfTokenHelper;
use API;
use Modules\NetworkTopology\Topology\NodePositions;
use Modules\NetworkTopology\Topology\Revision;

/**
 * NetworkTopologyPositions
 *
 * Speichert die Knotenpositionen serverseitig — bis 5.0 lagen sie im
 * localStorage und waren damit an einen Browser gebunden.
 *
 * Request (POST):
 *   positions  JSON, {"<viewKey>": {"<nodeId>": {"x":100,"y":-40}, ...}}
 *   scope      "shared" | "personal"
 *   nt_csrf    CSRF-Token
 *
 * Response: { ok: true, scope, views } oder { error }
 *
 * Zwei Ebenen, siehe NodePositions:
 *   shared    module.config — DIE Karte, nur Super-Admins schreiben
 *   personal  CProfile      — die eigene Abweichung davon
 *
 * GET returns the effective positions of readable hosts for one map view.
 * POST requires CSRF, AJAX and Super Admin permission for shared writes. Die
 * Node-IDs validiert NodePositions::sanitize() gegen ein enges Zeichenmuster —
 * sie landen spaeter wieder als Element-IDs im DOM.
 *
 * Die Drosselung ist hier straffer als bei den Links: Positionen werden beim
 * Ziehen gespeichert, das Frontend entprellt zwar (400 ms), aber ein haengender
 * Client koennte sonst dauerhaft schreiben.
 */
class NetworkTopologyPositions extends NetworkTopologyController {

    /**
     * Laengen-Cap fuer das rohe JSON. MAX_NODES (5000) x ~30 Zeichen je
     * Eintrag, plus Reserve fuer mehrere Views. Verhindert, dass json_decode
     * auf einem Megabyte-Payload arbeitet.
     */
    private const MAX_PAYLOAD = 524288;

    protected function init(): void {
        $this->disableCsrfValidation();
    }

    protected function checkInput(): bool {
        $method = $_SERVER['REQUEST_METHOD'] ?? '';
        if (!in_array($method, ['GET', 'POST'], true)) {
            $this->jsonResponse(['error' => 'Method not allowed']);
            return false;
        }

        if (!$this->requireAjax()) {
            return false;
        }

        if ($method === 'GET') {
            if (!$this->validateInput(['view' => 'required|string', 'since' => 'string'])
                    || !$this->validFollowView((string) $this->getInput('view', ''))) {
                $this->jsonResponse(['error' => 'Invalid layout view']);
                return false;
            }
            return true;
        }

        $ret = $this->validateInput([
            'positions' => 'required|string',
            // Revision, auf der die Aenderung beruht. Optional.
            'base'      => 'string',
            'scope'     => 'required|in shared,personal',
            'nt_csrf'   => 'string',
        ]);

        if (!$ret) {
            $this->jsonResponse(['error' => 'Invalid input']);
            return false;
        }

        if (!CCsrfTokenHelper::check((string) $this->getInput('nt_csrf', ''),
                'network.topology.positions')) {
            $this->jsonResponse(['error' => 'CSRF token invalid']);
            return false;
        }

        return true;
    }

    protected function checkPermissions(): bool {
        // Die eigene Anordnung darf jeder speichern, der die Karte sehen darf.
        // Die schaerfere Huerde fuer scope=shared steht in doAction().
        return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
    }

    protected function doAction(): void {
        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
            if ($this->throttle('positions_read', 24, 10)) {
                $this->readPositions();
            }
            return;
        }

        if (!$this->throttle('positions', 30, 10)) {
            return;
        }

        $scope = (string) $this->getInput('scope', NodePositions::SCOPE_PERSONAL);
        $raw   = (string) $this->getInput('positions', '{}');

        if (strlen($raw) > self::MAX_PAYLOAD) {
            $this->jsonResponse(['error' => 'Payload too large']);
            return;
        }

        $decoded = json_decode($raw, true);

        if (!is_array($decoded)) {
            $this->jsonResponse(['error' => 'Invalid positions payload']);
            return;
        }

        if ($scope === NodePositions::SCOPE_SHARED
                && $this->getUserType() !== USER_TYPE_SUPER_ADMIN) {
            $this->jsonResponse([
                'error' => _('Only Super admins can change the shared layout.')
            ]);
            return;
        }

        // Siehe NetworkTopologyLinks: beide Ebenen speichern den
        // VOLLSTAENDIGEN Zustand. Ohne diese Pruefung ueberschreibt der letzte
        // Schreiber die Arbeit des vorigen, ohne dass jemand etwas merkt.
        $current = $scope === NodePositions::SCOPE_SHARED
            ? NodePositions::loadShared()
            : NodePositions::loadPersonal();

        if (!Revision::matches((string) $this->getInput('base', ''), $current)) {
            $this->jsonResponse([
                'error'     => _('The layout was changed elsewhere in the meantime.'),
                'conflict'  => true,
                'positions' => $current,
                'revision'  => Revision::of($current)
            ]);
            return;
        }

        try {
            $saved = $scope === NodePositions::SCOPE_SHARED
                ? NodePositions::saveShared($decoded)
                : NodePositions::savePersonal($decoded);
        }
        catch (\Throwable $e) {
            // Siehe NetworkTopologyLinks: nur APIException-Meldungen gehen an
            // den Client, alles andere koennte interne Details tragen. Der
            // volle Fehler landet im Serverlog, wo er hingehoert.
            error_log('network.topology.positions: ' . $e);
            $this->jsonResponse(['error' => $e instanceof \APIException
                ? $e->getMessage()
                : _('The positions could not be saved (internal error).')]);
            return;
        }

        // Nur die Anzahl zurueck, nicht die Daten: der Client kennt sie schon,
        // und eine volle Karte waere eine unnoetig grosse Antwort.
        //
        // truncated sagt, wie viele Knoten die Obergrenze verworfen hat. Ist
        // der Wert > 0, wurde nur ein Teil gespeichert — das muss der Nutzer
        // erfahren, sonst fehlen beim naechsten Laden Positionen ohne Grund.
        $this->jsonResponse([
            'ok'        => true,
            'scope'     => $scope,
            'views'     => count($saved),
            'truncated'       => NodePositions::lastTruncated(),
            // Getrennt gemeldet: Knoten und Ansichten sind verschiedene Dinge,
            // und eine Summe waere in beiden Bedeutungen falsch.
            'truncated_views' => NodePositions::lastTruncatedViews(),
            'revision'        => Revision::of($saved)
        ]);
    }

    private function validFollowView(string $view): bool {
        return strlen($view) <= 200 && preg_match(
            '/\A(?:[0-9]{1,20}(?:_[0-9]{1,20})*|host[0-9]{1,20}_h[1-6])\z/', $view
        ) === 1;
    }

    private function readPositions(): void {
        $view = (string) $this->getInput('view');
        $shared = NodePositions::loadShared();
        $personal = NodePositions::loadPersonal();
        $positions = array_replace($shared[$view] ?? [], $personal[$view] ?? []);
        $hostids = array_values(array_filter(array_map('strval', array_keys($positions)), 'ctype_digit'));
        $visible = [];

        if ($hostids) {
            if (preg_match('/\Ahost([0-9]+)_h[1-6]\z/', $view, $root)) {
                $can_read = API::Host()->get(['hostids' => [$root[1]], 'output' => []]);
                $scope = [];
            } else {
                $groupids = array_values(array_unique(explode('_', $view)));
                $groups = API::HostGroup()->get(['groupids' => $groupids, 'output' => []]);
                $can_read = is_array($groups) && count($groups) === count($groupids);
                $scope = ['groupids' => $groupids];
            }

            if ($can_read) {
                $visible = API::Host()->get($scope + [
                    'hostids' => $hostids, 'output' => [], 'preservekeys' => true
                ]);
            }
        }

        // Check current permissions even if the coordinates have not changed.
        // Scope the revision and response to this view and its readable hosts.
        $positions = array_intersect_key($positions, is_array($visible) ? $visible : []);
        $revision = Revision::of($positions);
        $response = ['ok' => true, 'revision' => $revision];
        if (!hash_equals($revision, (string) $this->getInput('since', ''))) {
            $response['positions'] = (object) $positions;
        }
        $this->jsonResponse($response);
    }
}
