This fixture is for the disposable local Zabbix Docker lab on port 18080. It
creates synthetic hosts under `Topology Layout Lab` and feeds their LLDP item
values through `zabbix_sender`. The Event fixture is a hub with four access
switches, ghost endpoints and a media server with monitored guests. The Fabric
fixture has two spines, six dual-homed leaves and twelve access switches. Use
Fabric for a single group, or Fabric A and Fabric B for the same devices split
between two host groups. Control Room and Machine Room exercise small
groups. Select the four North and South groups to test 104 devices across
two sites, or select Utility and Media 2110 to see those same networks across
both sites. Studio Encoder reports three separate links to the Media Red,
Media Blue, and Utility switches.

**Live Event** has 31 devices and 50 cables. Three Red leaves and three Blue
leaves uplink to their matching media cores. Each of the 20 Utility access
switches has one uplink to each Utility core. Event Router links to all four
cores. Select **Live Event** for the whole map, or select **Live Event/Media
Red**, **Media Blue**, **Utility**, and **Routing** under Live Event to try
group colours or separate group layouts. Group labels ending in Red or Blue
use the corresponding colour in both modes.

Mount the current module and build its frontend bundle before running:

```sh
npm run build
python3 tools/layout-lab/fixture.py seed
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tools/layout-lab/browser.mjs /tmp/topology-layout-results
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tools/layout-lab/toolbar.mjs /tmp/topology-toolbar-audit.json
```

The harness requires local Chrome and Playwright Firefox. It compares
Cytoscape layout coordinates and records screenshots. The crossing count
compares straight lines between centres; the overlap count compares node and
label bounds. Set `NT_BASELINE_BUNDLE` to an earlier built bundle to include
the previous Rows layout in the comparison. The Force outputs can vary
between runs. The harness also opens a Firefox kiosk before dragging a node
in Chrome, checks that Firefox follows the saved position at its own zoom and
pan, checks permissions with a temporary read-only user, then changes and restores an
LLDP neighbour on the normal refresh timer. While the old neighbour is absent,
its edge must become stale and the new neighbour must be drawn; the module's
normal stale edge lifetime is unchanged. The test resets saved positions
for the synthetic Event view and restores its LLDP readings on exit.

The toolbar audit uses Chrome and compares the local v5.6.9 and v5.6.10
tags. It enters fullscreen from the mapper's View menu, records button bounds
and hit tests with menus open at three viewport widths, and exercises both
label and padding clicks. It also checks the MAC popup, severity filter,
search field, and zoom percentage.

In the Technical tab, choose **Layout → Follow layout** on the kiosk. Follow
mode tracks saved monitored host positions for the selected map view.
It is specific to the browser tab and pauses position editing while enabled.
Use **Layout → Cluster → colours only** to identify host groups with
coloured rings and a legend. Rows and Columns give each group its own space.
An endpoint with current LLDP, CDP, or declared uplinks into multiple host
groups appears in a shared area between its groups, with a separate cable
to each switch. Selecting a single Media 2110 group combines the two group
labels while keeping the Red and Blue cables visible.
