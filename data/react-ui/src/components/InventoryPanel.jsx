import { useEffect, useMemo, useState } from "react";
import { AtlasAPI } from "../api";

const CONTROLLER_SITE = { id: "controller", name: "Controller" };
const ALL_SITES = { id: "all", name: "All sites" };
const SITE_STORAGE_KEY = "atlas.inventory.site";

function looksLikeIp(value) {
  return /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.test(String(value || ""));
}

function describePorts(ports = []) {
  if (!Array.isArray(ports) || !ports.length) return "no_ports";
  return ports
    .map((port) => {
      if (!port || typeof port !== "object") return "";
      const proto = port.protocol || "tcp";
      const label = port.service ? ` (${port.service})` : "";
      return `${port.port}/${proto}${label}`;
    })
    .filter(Boolean)
    .join(", ");
}

function normalizeControllerHost(row, group, siteName) {
  const ip = looksLikeIp(row[1]) ? String(row[1]) : "";
  const dockerIp = looksLikeIp(row[2]) ? String(row[2]) : ip;
  const detectedIp = group === "docker" ? dockerIp || ip : ip;
  const hostname = row[2] || row[3] || row[1] || "NoName";
  const os = row[4] || row[3] || "Unknown";
  const onlineStatus = (row[10] || row[9] || "unknown").toString();
  const lastSeen = row[9] || row[10] || "";

  const missingHostname = !hostname || hostname === detectedIp || hostname === "NoName";
  const missingOs = !os || String(os).toLowerCase() === "unknown";

  return {
    id: row[0],
    hostname,
    ip: detectedIp,
    os,
    mac: row[5] || row[4] || "Unknown",
    ports: row[6] || "no_ports",
    network: row[8] || row[7] || "",
    interfaceName: row[8] || "N/A",
    status: onlineStatus,
    lastSeen,
    group,
    siteId: CONTROLLER_SITE.id,
    siteName,
    isUnknown: missingHostname || missingOs,
    unknownReasons: [
      missingHostname ? "Hostname not reported" : null,
      missingOs ? "OS unknown" : null,
    ].filter(Boolean),
  };
}

function normalizeRemoteHost(host, siteId, siteName, idx = 0) {
  const ports = describePorts(host?.ports);
  const metadata = host?.metadata || {};
  const network = metadata.network || metadata.subnet || metadata.vlan || "remote";
  const interfaceName = metadata.interface_name || metadata.interface || metadata.iface || "remote";
  const status = metadata.online_status || metadata.state || host?.status || "online";
  const hostname = host?.hostname || host?.ip || "Unknown";
  const os = host?.os || "Unknown";
  const missingHostname = !hostname || hostname === host?.ip;
  const missingOs = !os || String(os).toLowerCase() === "unknown";

  return {
    id: host?.id || `${siteId || "remote"}-${idx}`,
    hostname,
    ip: host?.ip || "",
    os,
    mac: host?.mac || "Unknown",
    ports: ports || "no_ports",
    network,
    interfaceName,
    status,
    lastSeen: host?.last_seen || host?.updated_at || "",
    group: "remote",
    siteId,
    siteName,
    isUnknown: missingHostname || missingOs,
    unknownReasons: [
      missingHostname ? "Hostname missing" : null,
      missingOs ? "OS unknown" : null,
    ].filter(Boolean),
  };
}

function summarizeAssets(assets) {
  const osCounts = assets.reduce(
    (acc, asset) => {
      const osValue = (asset.os || "").toLowerCase();
      if (osValue.includes("windows")) acc.windows += 1;
      else if (osValue.includes("linux")) acc.linux += 1;
      else if (osValue.includes("mac") || osValue.includes("darwin")) acc.mac += 1;
      else acc.other += 1;
      return acc;
    },
    { windows: 0, linux: 0, mac: 0, other: 0 }
  );

  const bySite = assets.reduce((map, asset) => {
    const current = map.get(asset.siteId) || { name: asset.siteName, total: 0, unknown: 0 };
    current.total += 1;
    if (asset.isUnknown) current.unknown += 1;
    map.set(asset.siteId, current);
    return map;
  }, new Map());

  return {
    osCounts,
    bySite,
    total: assets.length,
    unknown: assets.filter((a) => a.isUnknown).length,
  };
}

export default function InventoryPanel() {
  const [siteSummary, setSiteSummary] = useState([]);
  const [assets, setAssets] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState(() => {
    if (typeof window === "undefined") return ALL_SITES.id;
    return window.localStorage.getItem(SITE_STORAGE_KEY) || ALL_SITES.id;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [partialErrors, setPartialErrors] = useState([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [unknownOnly, setUnknownOnly] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      try {
        const summary = await AtlasAPI.getSiteSummary();
        if (cancelled) return;
        setSiteSummary(summary || []);
      } catch (err) {
        if (!cancelled) {
          setSiteSummary([]);
          setError(err.message || String(err));
        }
      }
    }

    loadSummary();
    const timer = setInterval(loadSummary, 20000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SITE_STORAGE_KEY, selectedSiteId);
  }, [selectedSiteId]);

  useEffect(() => {
    if (!siteSummary.length) return;
    if (selectedSiteId === CONTROLLER_SITE.id || selectedSiteId === ALL_SITES.id) return;
    const exists = siteSummary.some((s) => s.site_id === selectedSiteId);
    if (!exists) setSelectedSiteId(ALL_SITES.id);
  }, [selectedSiteId, siteSummary]);

  useEffect(() => {
    let cancelled = false;

    async function loadControllerHosts() {
      const json = await AtlasAPI.getHosts();
      const hostsRows = Array.isArray(json?.[0]) ? json[0] : [];
      const dockerRows = Array.isArray(json?.[1]) ? json[1] : [];
      return [
        ...hostsRows.map((row) => normalizeControllerHost(row, "normal", CONTROLLER_SITE.name)),
        ...dockerRows.map((row) => normalizeControllerHost(row, "docker", CONTROLLER_SITE.name)),
      ];
    }

    async function loadRemoteHosts(siteId) {
      const siteMeta = siteSummary.find((s) => s.site_id === siteId);
      const siteName = siteMeta?.site_name || siteId;
      const hosts = await AtlasAPI.getSiteHosts(siteId);
      return hosts.map((h, idx) => normalizeRemoteHost(h, siteId, siteName, idx));
    }

    async function loadAssets() {
      setLoading(true);
      setError(null);
      setPartialErrors([]);
      try {
        if (selectedSiteId === ALL_SITES.id) {
          const promises = [loadControllerHosts(), ...siteSummary.map((s) => loadRemoteHosts(s.site_id))];
          const results = await Promise.allSettled(promises);
          if (cancelled) return;
          const collected = [];
          const failures = [];
          results.forEach((res, idx) => {
            if (res.status === "fulfilled") {
              collected.push(...res.value);
            } else {
              const label = idx === 0 ? CONTROLLER_SITE.name : siteSummary[idx - 1]?.site_name || "remote site";
              failures.push(`${label}: ${res.reason?.message || res.reason}`);
            }
          });
          setAssets(collected);
          setPartialErrors(failures);
        } else if (selectedSiteId === CONTROLLER_SITE.id) {
          const controllerAssets = await loadControllerHosts();
          if (!cancelled) setAssets(controllerAssets);
        } else {
          const remoteAssets = await loadRemoteHosts(selectedSiteId);
          if (!cancelled) setAssets(remoteAssets);
        }
        setLastUpdated(new Date());
      } catch (err) {
        if (!cancelled) {
          setAssets([]);
          setError(err.message || String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadAssets();
    return () => {
      cancelled = true;
    };
  }, [selectedSiteId, siteSummary]);

  const filteredAssets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return assets
      .filter((asset) => {
        if (unknownOnly && !asset.isUnknown) return false;
        if (statusFilter !== "all" && (asset.status || "").toLowerCase() !== statusFilter) return false;
        if (!needle) return true;
        return (
          asset.hostname.toLowerCase().includes(needle) ||
          asset.ip.toLowerCase().includes(needle) ||
          (asset.os || "").toLowerCase().includes(needle) ||
          (asset.network || "").toLowerCase().includes(needle) ||
          (asset.ports || "").toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
  }, [assets, query, statusFilter, unknownOnly]);

  const hasFilters = useMemo(
    () => Boolean(query.trim() || unknownOnly || statusFilter !== "all"),
    [query, unknownOnly, statusFilter]
  );
  const hiddenCount = hasFilters ? assets.length - filteredAssets.length : 0;

  const summary = useMemo(() => summarizeAssets(assets), [assets]);
  const unknownAssets = useMemo(() => assets.filter((a) => a.isUnknown).slice(0, 8), [assets]);
  const portlessCount = useMemo(
    () =>
      assets.filter((asset) => {
        const ports = (asset.ports ?? "").toString().trim();
        return !ports || ports === "no_ports" || ports === "—";
      }).length,
    [assets]
  );

  const siteOptions = [CONTROLLER_SITE, ...siteSummary.map((s) => ({ id: s.site_id, name: s.site_name || s.site_id })), ALL_SITES];

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-y-auto pb-4">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Asset Inventory</h2>
          <p className="text-gray-600">
            Explore everything the scanner has discovered across controller and remote sites. Unknown entries stay highlighted so we can enrich them with SSH collection soon.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="text-sm text-gray-700">Site filter</label>
          <select
            className="rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
            value={selectedSiteId}
            onChange={(e) => setSelectedSiteId(e.target.value)}
          >
            {siteOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSelectedSiteId((prev) => prev)}
            className="px-3 py-1 rounded bg-gray-100 text-sm text-gray-700 hover:bg-gray-200"
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {(error || partialErrors.length > 0) && (
        <div className="space-y-1 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error && <div>{error}</div>}
          {partialErrors.map((msg) => (
            <div key={msg}>Partial load issue: {msg}</div>
          ))}
        </div>
      )}

      {portlessCount > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Ports not reported for {portlessCount} asset{portlessCount === 1 ? "" : "s"}. Agents deep scan by default—if data
          stays incomplete, ensure the container runs with <code className="mx-1">NET_RAW</code> and
          <code className="mx-1">NET_ADMIN</code> capabilities or wait for the next scan cycle.
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">Assets</p>
          <p className="text-3xl font-bold text-gray-900">{summary.total}</p>
          <p className="text-sm text-gray-500">Across {summary.bySite.size || 1} site(s)</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">Unknown</p>
          <p className="text-3xl font-bold text-amber-600">{summary.unknown}</p>
          <p className="text-sm text-gray-500">Missing hostname or OS</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">Linux</p>
          <p className="text-3xl font-bold text-gray-900">{summary.osCounts.linux}</p>
          <p className="text-sm text-gray-500">Ready for SSH enrichment</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">Windows/Mac/Other</p>
          <p className="text-3xl font-bold text-gray-900">{summary.osCounts.windows + summary.osCounts.mac + summary.osCounts.other}</p>
          <p className="text-sm text-gray-500">Waiting for agent insights</p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3 min-h-0 flex-1">
        <div className="lg:col-span-2 flex flex-col rounded-lg border border-gray-200 bg-white shadow-sm min-h-0">
          <div className="flex flex-wrap gap-3 items-center justify-between border-b border-gray-100 px-4 py-3">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Assets</h3>
              <p className="text-sm text-gray-500">
                Showing {filteredAssets.length} of {assets.length} assets
                {selectedSiteId !== ALL_SITES.id && siteOptions.find((o) => o.id === selectedSiteId)
                  ? ` at ${siteOptions.find((o) => o.id === selectedSiteId)?.name}`
                  : ""}
                {hiddenCount > 0 && (
                  <span className="ml-2 text-amber-700">({hiddenCount} hidden by filters)</span>
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                placeholder="Search hostname, IP, OS, network"
                className="w-64 rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">Any status</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="running">Running</option>
                <option value="stopped">Stopped</option>
              </select>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  checked={unknownOnly}
                  onChange={(e) => setUnknownOnly(e.target.checked)}
                />
                Unknown only
              </label>
              {hasFilters && (
                <button
                  type="button"
                  className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-100"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                    setUnknownOnly(false);
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left">Site</th>
                  <th className="px-3 py-2 text-left">Hostname</th>
                  <th className="px-3 py-2 text-left">IP</th>
                  <th className="px-3 py-2 text-left">OS</th>
                  <th className="px-3 py-2 text-left">Network</th>
                  <th className="px-3 py-2 text-left">Ports</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Last seen</th>
                  <th className="px-3 py-2 text-left">Access</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredAssets.map((asset) => (
                  <tr key={`${asset.siteId}-${asset.id}`} className={asset.isUnknown ? "bg-amber-50" : ""}>
                    <td className="px-3 py-2 text-xs font-semibold text-gray-700">{asset.siteName}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{asset.hostname || "Unknown"}</div>
                      <div className="text-xs text-gray-500">{asset.group}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{asset.ip || "—"}</td>
                    <td className="px-3 py-2 text-gray-800">{asset.os}</td>
                    <td className="px-3 py-2 text-gray-700">{asset.network || "—"}</td>
                    <td className="px-3 py-2 text-gray-700">{asset.ports || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                        (asset.status || "").toLowerCase().includes("online") || (asset.status || "").toLowerCase().includes("running")
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-200 text-gray-700"
                      }`}>
                        {asset.status || "unknown"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">{asset.lastSeen || "—"}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      <span className="inline-flex items-center gap-1 rounded border border-dashed border-blue-200 px-2 py-0.5 text-blue-700">
                        <span className="h-2 w-2 rounded-full bg-blue-400" />
                        SSH enrichment soon
                      </span>
                    </td>
                  </tr>
                ))}
                {!filteredAssets.length && (
                  <tr>
                    <td className="px-3 py-4 text-center text-sm text-gray-500" colSpan={9}>
                      {loading ? "Loading inventory…" : "No assets match your filters"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500 flex items-center justify-between">
            <span>{loading ? "Refreshing inventory…" : "Inventory snapshot"}</span>
            {lastUpdated && <span>Updated {lastUpdated.toLocaleTimeString()}</span>}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-4 py-3">
              <h3 className="text-lg font-semibold text-gray-900">Sites overview</h3>
              <p className="text-sm text-gray-500">Live totals from selected data</p>
            </div>
            <div className="max-h-64 overflow-auto divide-y">
              {Array.from(summary.bySite.entries()).map(([id, info]) => (
                <div key={id} className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{info.name}</p>
                    <p className="text-xs text-gray-500">{info.unknown} unknown</p>
                  </div>
                  <span className="text-xl font-bold text-gray-800">{info.total}</span>
                </div>
              ))}
              {!summary.bySite.size && (
                <div className="px-4 py-6 text-sm text-gray-500">No sites loaded yet</div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white shadow-sm flex-1">
            <div className="border-b border-gray-100 px-4 py-3">
              <h3 className="text-lg font-semibold text-gray-900">Needs enrichment</h3>
              <p className="text-sm text-gray-500">Top entries without hostname/OS</p>
            </div>
            <div className="flex-1 overflow-auto divide-y">
              {unknownAssets.map((asset) => (
                <div key={`unknown-${asset.siteId}-${asset.id}`} className="px-4 py-3">
                  <p className="font-medium text-gray-900">{asset.hostname || asset.ip || "Unknown host"}</p>
                  <p className="text-xs text-gray-500">{asset.siteName}</p>
                  <ul className="mt-1 text-xs text-amber-700 list-disc list-inside">
                    {asset.unknownReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {!unknownAssets.length && (
                <div className="px-4 py-6 text-sm text-gray-500">Everything here has a hostname and OS</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
