import { useEffect, useMemo, useRef, useState } from "react";
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

function formatPortList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((port) => {
        if (!port) return null;
        if (typeof port === "string") return port.trim();
        const proto = port.protocol || "tcp";
        const label = port.service ? ` (${port.service})` : "";
        return `${port.port || port.portid || ""}/${proto}${label}`.trim();
      })
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }

  return [];
}

function ipToNumber(ip) {
  const parts = String(ip || "")
    .split(".")
    .map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, part) => (acc << 8) + part, 0);
}

function matchesIpFilter(ip, filter) {
  if (!filter) return true;
  const value = filter.trim();
  const ipNum = ipToNumber(ip);
  if (ipNum === null) return false;

  if (value.includes("/")) {
    const [base, maskStr] = value.split("/");
    const mask = Number(maskStr);
    const baseNum = ipToNumber(base);
    if (baseNum === null || Number.isNaN(mask)) return false;
    const maskBits = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
    return (ipNum & maskBits) === (baseNum & maskBits);
  }

  if (value.includes("-")) {
    const [start, end] = value.split("-").map((part) => ipToNumber(part));
    if (start === null || end === null) return false;
    return ipNum >= start && ipNum <= end;
  }

  return ip.includes(value);
}

function normalizeControllerHost(row, group, siteName) {
  const ip = looksLikeIp(row[1]) ? String(row[1]) : "";
  const dockerIp = looksLikeIp(row[2]) ? String(row[2]) : ip;
  const detectedIp = group === "docker" ? dockerIp || ip : ip;
  const hostname = row[2] || row[3] || row[1] || "NoName";
  const os = row[4] || row[3] || "Unknown";
  const onlineStatus = (row[10] || row[9] || "unknown").toString();
  const lastSeen = row[9] || row[10] || "";
  const portList = formatPortList(row[6]);
  const portsLabel = portList.length ? `${portList.length} open` : "no_ports";

  const missingHostname =
    !hostname || hostname === detectedIp || hostname === "NoName";
  const missingOs = !os || String(os).toLowerCase() === "unknown";

  return {
    id: row[0],
    hostname,
    ip: detectedIp,
    os,
    mac: row[5] || row[4] || "Unknown",
    ports: portsLabel,
    portList,
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
  const portList = formatPortList(host?.ports);
  const ports = portList.length
    ? `${portList.length} open`
    : describePorts(host?.ports);
  const metadata = host?.metadata || {};
  const network =
    metadata.network || metadata.subnet || metadata.vlan || "remote";
  const interfaceName =
    metadata.interface_name || metadata.interface || metadata.iface || "remote";
  const status =
    metadata.online_status || metadata.state || host?.status || "online";
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
    portList,
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
      else if (osValue.includes("mac") || osValue.includes("darwin"))
        acc.mac += 1;
      else acc.other += 1;
      return acc;
    },
    { windows: 0, linux: 0, mac: 0, other: 0 },
  );

  const bySite = assets.reduce((map, asset) => {
    const current = map.get(asset.siteId) || {
      name: asset.siteName,
      total: 0,
      unknown: 0,
    };
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

const PAGE_SIZE = 15;

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
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [ipFilter, setIpFilter] = useState("");
  const [lastSeenFilter, setLastSeenFilter] = useState("any");
  const [groupBy, setGroupBy] = useState("none");
  const [sortConfig, setSortConfig] = useState({
    key: "hostname",
    direction: "asc",
  });
  const [siteFilter, setSiteFilter] = useState("all");
  const [subnetFilter, setSubnetFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [acknowledgedIds, setAcknowledgedIds] = useState(new Set());
  const [bulkStatus, setBulkStatus] = useState(null);
  const [portExpansions, setPortExpansions] = useState({});
  const [page, setPage] = useState(1);
  const [activeAsset, setActiveAsset] = useState(null);

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
    if (
      selectedSiteId === CONTROLLER_SITE.id ||
      selectedSiteId === ALL_SITES.id
    )
      return;
    const exists = siteSummary.some((s) => s.site_id === selectedSiteId);
    if (!exists) setSelectedSiteId(ALL_SITES.id);
  }, [selectedSiteId, siteSummary]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [assets]);

  useEffect(() => {
    if (selectedSiteId !== ALL_SITES.id) {
      setSiteFilter("all");
    }
  }, [selectedSiteId]);

  useEffect(() => {
    let cancelled = false;

    async function loadControllerHosts() {
      const json = await AtlasAPI.getHosts();
      const hostsRows = Array.isArray(json?.[0]) ? json[0] : [];
      const dockerRows = Array.isArray(json?.[1]) ? json[1] : [];
      return [
        ...hostsRows.map((row) =>
          normalizeControllerHost(row, "normal", CONTROLLER_SITE.name),
        ),
        ...dockerRows.map((row) =>
          normalizeControllerHost(row, "docker", CONTROLLER_SITE.name),
        ),
      ];
    }

    async function loadRemoteHosts(siteId) {
      const siteMeta = siteSummary.find((s) => s.site_id === siteId);
      const siteName = siteMeta?.site_name || siteId;
      const hosts = await AtlasAPI.getSiteHosts(siteId);
      return hosts.map((h, idx) =>
        normalizeRemoteHost(h, siteId, siteName, idx),
      );
    }

    async function loadAssets() {
      setLoading(true);
      setError(null);
      setPartialErrors([]);
      try {
        if (selectedSiteId === ALL_SITES.id) {
          const promises = [
            loadControllerHosts(),
            ...siteSummary.map((s) => loadRemoteHosts(s.site_id)),
          ];
          const results = await Promise.allSettled(promises);
          if (cancelled) return;
          const collected = [];
          const failures = [];
          results.forEach((res, idx) => {
            if (res.status === "fulfilled") {
              collected.push(...res.value);
            } else {
              const label =
                idx === 0
                  ? CONTROLLER_SITE.name
                  : siteSummary[idx - 1]?.site_name || "remote site";
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
    const now = Date.now();
    const maxAge = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
    };

    return assets.filter((asset) => {
      if (unknownOnly && !asset.isUnknown) return false;
      if (
        statusFilter !== "all" &&
        (asset.status || "").toLowerCase() !== statusFilter
      )
        return false;
      if (
        selectedSiteId === ALL_SITES.id &&
        siteFilter !== "all" &&
        asset.siteId !== siteFilter
      )
        return false;
      if (ipFilter && !matchesIpFilter(asset.ip, ipFilter)) return false;
      if (subnetFilter && !asset.ip.startsWith(subnetFilter)) return false;
      if (lastSeenFilter !== "any") {
        const ts = new Date(asset.lastSeen || 0).getTime();
        const age = now - ts;
        if (Number.isNaN(ts)) return false;
        if (lastSeenFilter === "hour" && age > maxAge.hour) return false;
        if (lastSeenFilter === "day" && age > maxAge.day) return false;
        if (lastSeenFilter === "week" && age > maxAge.week) return false;
        if (lastSeenFilter === "stale" && age < maxAge.day) return false;
      }

      if (!needle) return true;
      return (
        asset.hostname.toLowerCase().includes(needle) ||
        asset.ip.toLowerCase().includes(needle) ||
        (asset.os || "").toLowerCase().includes(needle) ||
        (asset.network || "").toLowerCase().includes(needle) ||
        (asset.ports || "").toLowerCase().includes(needle)
      );
    });
  }, [assets, ipFilter, lastSeenFilter, query, statusFilter, unknownOnly]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredAssets.length / PAGE_SIZE) || 1),
    [filteredAssets.length],
  );

  const pageStart = filteredAssets.length ? (page - 1) * PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(filteredAssets.length, page * PAGE_SIZE);
  const pageRangeLabel = filteredAssets.length
    ? `${pageStart}–${pageEnd}`
    : "0";

  useEffect(() => {
    setPage((prev) => Math.min(prev, totalPages));
  }, [totalPages]);

  useEffect(() => {
    setPage(1);
  }, [
    query,
    statusFilter,
    unknownOnly,
    selectedSiteId,
    siteFilter,
    ipFilter,
    subnetFilter,
    lastSeenFilter,
    groupBy,
  ]);

  const sortedAssets = useMemo(() => {
    const sorted = [...filteredAssets];
    const dir = sortConfig.direction === "asc" ? 1 : -1;
    sorted.sort((a, b) => {
      const key = sortConfig.key;
      const normalize = (val) =>
        val === undefined || val === null ? "" : String(val).toLowerCase();
      if (
        key === "hostname" ||
        key === "os" ||
        key === "network" ||
        key === "site" ||
        key === "status"
      ) {
        const left = key === "site" ? normalize(a.siteName) : normalize(a[key]);
        const right =
          key === "site" ? normalize(b.siteName) : normalize(b[key]);
        return left.localeCompare(right) * dir;
      }
      if (key === "ip") {
        return ((ipToNumber(a.ip) || 0) - (ipToNumber(b.ip) || 0)) * dir;
      }
      if (key === "ports") {
        return ((a.portList?.length || 0) - (b.portList?.length || 0)) * dir;
      }
      if (key === "lastSeen") {
        return (
          (new Date(a.lastSeen || 0).getTime() -
            new Date(b.lastSeen || 0).getTime()) *
          dir
        );
      }
      return 0;
    });
    return sorted;
  }, [filteredAssets, sortConfig]);

  const paginatedAssets = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return sortedAssets.slice(start, start + PAGE_SIZE);
  }, [page, sortedAssets]);

  const groupedAssets = useMemo(() => {
    if (groupBy === "none")
      return paginatedAssets.map((asset) => ({ type: "asset", asset }));
    const map = new Map();
    paginatedAssets.forEach((asset) => {
      const key =
        groupBy === "site"
          ? asset.siteName || "Unknown site"
          : (asset.status || "unknown").toLowerCase();
      const label =
        groupBy === "site" ? key : key.charAt(0).toUpperCase() + key.slice(1);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(asset);
    });

    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .flatMap(([label, items]) => [
        { type: "group", label, count: items.length },
        ...items.map((asset) => ({ type: "asset", asset })),
      ]);
  }, [groupBy, paginatedAssets]);

  const hasFilters = useMemo(
    () =>
      Boolean(
        query.trim() ||
          ipFilter.trim() ||
          unknownOnly ||
          statusFilter !== "all" ||
          lastSeenFilter !== "any" ||
          (selectedSiteId === ALL_SITES.id && siteFilter !== "all") ||
          subnetFilter.trim(),
      ),
    [
      ipFilter,
      lastSeenFilter,
      query,
      selectedSiteId,
      siteFilter,
      statusFilter,
      subnetFilter,
      unknownOnly,
    ],
  );
  const hiddenCount = hasFilters ? assets.length - filteredAssets.length : 0;

  const summary = useMemo(
    () => summarizeAssets(filteredAssets),
    [filteredAssets],
  );
  const portlessCount = useMemo(
    () =>
      assets.filter((asset) => {
        const ports = (asset.ports ?? "").toString().trim();
        return !ports || ports === "no_ports" || ports === "—";
      }).length,
    [assets],
  );

  const siteOptions = [
    CONTROLLER_SITE,
    ...siteSummary.map((s) => ({
      id: s.site_id,
      name: s.site_name || s.site_id,
    })),
    ALL_SITES,
  ];
  const assetsTableRef = useRef(null);
  const assetRowId = (asset) => `${asset.siteId}-${asset.id}`;
  const visibleAssetIds = paginatedAssets.map(assetRowId);
  const selectedVisibleIds = visibleAssetIds.filter((id) =>
    selectedIds.has(id),
  );
  const allSelected =
    visibleAssetIds.length > 0 &&
    selectedVisibleIds.length === visibleAssetIds.length;
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (visibleAssetIds.length === 0) return new Set();
      if (visibleAssetIds.every((id) => prev.has(id))) return new Set();
      return new Set(visibleAssetIds);
    });
  };
  const togglePorts = (id) =>
    setPortExpansions((prev) => ({ ...prev, [id]: !prev[id] }));

  const showUnknownAssets = () => {
    setUnknownOnly(true);
    setQuery("");
    setStatusFilter("all");
    setPage(1);
    assetsTableRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const setSortKey = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === "asc" ? "desc" : "asc",
    }));
  };

  const sortIndicator = (key) => {
    if (sortConfig.key !== key) return "↕";
    return sortConfig.direction === "asc" ? "↑" : "↓";
  };

  const selectedAssets = paginatedAssets.filter((asset) =>
    selectedIds.has(assetRowId(asset)),
  );
  const handleBulkConfirm = () => {
    if (!selectedAssets.length) return;
    setAcknowledgedIds((prev) => {
      const next = new Set(prev);
      selectedAssets.forEach((asset) => next.add(assetRowId(asset)));
      return next;
    });
    setBulkStatus(`${selectedAssets.length} assets marked as confirmed`);
  };

  const handleBulkUnknown = () => {
    setUnknownOnly(true);
    assetsTableRef.current?.scrollIntoView({ behavior: "smooth" });
    setBulkStatus("Filtering unknown assets");
  };

  const handleAssetClick = (asset) => setActiveAsset(asset);
  const closeAssetDetails = () => setActiveAsset(null);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">
            Asset Inventory
          </h2>
          <p className="text-gray-600">
            Explore everything the scanner has discovered across controller and
            remote sites. Unknown entries stay highlighted so we can enrich them
            with SSH collection soon.
          </p>
        </div>
        <div className="text-sm text-gray-600">
          <p className="font-semibold text-gray-800">Inventory workspace</p>
          <p>
            Assets first, with filters and details, followed by rollup metrics
            below.
          </p>
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
          Ports not reported for {portlessCount} assets. Agents deep scan by
          default—if data stays incomplete, ensure the container runs with{" "}
          <code className="mx-1">NET_RAW</code> and{" "}
          <code className="mx-1">NET_ADMIN</code> capabilities or wait for the
          next scan cycle.
        </div>
      )}


      <section className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Inventory snapshot
              </p>
              <h3 className="text-lg font-semibold text-gray-900">
                Filtered inventory
              </h3>
              <p className="text-sm text-gray-600">
                Numbers update instantly as you adjust the filters below.
              </p>
            </div>
            {lastUpdated && (
              <span className="text-xs text-gray-500">
                Updated {lastUpdated.toLocaleString()}
              </span>
            )}
          </div>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-gray-200 bg-gray-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-gray-500">
                Visible assets
              </dt>
              <dd className="text-2xl font-bold text-gray-900">
                {filteredAssets.length}
              </dd>
              <p className="text-xs text-gray-600">Shown in the table below.</p>
            </div>
            <div className="rounded border border-gray-200 bg-gray-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-gray-500">
                Hidden by filters
              </dt>
              <dd className="text-2xl font-bold text-gray-900">{hiddenCount}</dd>
              <p className="text-xs text-gray-600">
                Assets excluded by the current filters.
              </p>
            </div>
            <div className="rounded border border-gray-200 bg-gray-50 p-3 sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-gray-500">
                Sites represented
              </dt>
              <dd className="text-xl font-semibold text-gray-900">
                {summary.bySite.size || 0}
              </dd>
              <p className="text-xs text-gray-600">
                Matches the active scope and filters.
              </p>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm xl:col-span-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Network snapshot
              </p>
              <h3 className="text-lg font-semibold text-gray-900">
                Current filtered view
              </h3>
              <p className="text-sm text-gray-600">
                Overview aligned with the filters and refreshed with each
                change.
              </p>
            </div>
            {lastUpdated && (
              <span className="text-xs text-gray-500">
                Updated {lastUpdated.toLocaleString()}
              </span>
            )}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Assets
              </p>
              <p className="text-3xl font-bold text-gray-900">{summary.total}</p>
              <p className="text-sm text-gray-500">
                Across {summary.bySite.size || 1} site(s)
              </p>
            </div>
            <button
              type="button"
              onClick={showUnknownAssets}
              className={`text-left rounded-lg border p-3 shadow-sm transition hover:border-gray-300 hover:shadow ${
                unknownOnly
                  ? "border-amber-300 bg-amber-50"
                  : "border-gray-200 bg-white"
              }`}
              aria-pressed={unknownOnly}
            >
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Unknown
              </p>
              <p className="text-3xl font-bold text-amber-600">
                {summary.unknown}
              </p>
              <p className="text-sm text-gray-500">Missing hostname or OS</p>
              {unknownOnly && (
                <p className="mt-1 text-xs text-amber-700">
                  Filtering unknown assets
                </p>
              )}
            </button>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Known OS
              </p>
              <p className="text-lg font-semibold text-gray-900">
                {summary.osCounts.windows +
                  summary.osCounts.linux +
                  summary.osCounts.mac}
              </p>
              <p className="text-xs text-gray-500">
                Windows · Linux · macOS coverage
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Unknown share
              </p>
              <p className="text-lg font-semibold text-gray-900">
                {summary.total
                  ? Math.round((summary.unknown / summary.total) * 100)
                  : 0}
                %
              </p>
              <p className="text-xs text-gray-500">Use filters to reduce gaps</p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Filters</h3>
            <p className="text-sm text-gray-600">
              Adjust the scope before scrolling the table.
            </p>
          </div>
          {hasFilters && (
            <button
              type="button"
              className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-100"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
                setSiteFilter("all");
                setUnknownOnly(false);
                setIpFilter("");
                setSubnetFilter("");
                setLastSeenFilter("any");
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Search hostname, IP, OS, network"
              className="w-64 flex-1 min-w-[180px] rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
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
            {selectedSiteId === ALL_SITES.id && (
              <select
                className="rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
                value={siteFilter}
                onChange={(e) => setSiteFilter(e.target.value)}
              >
                <option value="all">Any site</option>
                {siteOptions
                  .filter((o) => o.id !== ALL_SITES.id)
                  .map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
              </select>
            )}
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
            <select
              className="rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
              value={lastSeenFilter}
              onChange={(e) => setLastSeenFilter(e.target.value)}
            >
              <option value="any">Any time</option>
              <option value="hour">Last hour</option>
              <option value="day">Last 24h</option>
              <option value="week">Last 7d</option>
              <option value="stale">Older than 24h</option>
            </select>
            <input
              type="text"
              value={subnetFilter}
              onChange={(e) => setSubnetFilter(e.target.value)}
              className="w-44 rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
              placeholder="Subnet prefix"
            />
            <button
              type="button"
              className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
              onClick={() => setAdvancedFiltersOpen((prev) => !prev)}
              aria-expanded={advancedFiltersOpen}
            >
              {advancedFiltersOpen ? "Hide details" : "More filters"}
            </button>
            <button
              type="button"
              onClick={() => setSelectedSiteId((prev) => prev)}
              className="rounded border border-blue-200 bg-blue-50 px-3 py-1 text-sm font-semibold text-blue-800 hover:bg-blue-100"
              disabled={loading}
            >
              Refresh
            </button>
            <label className="ml-auto inline-flex items-center gap-2 text-sm text-gray-700 align-middle">
              <input
                type="checkbox"
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                checked={unknownOnly}
                onChange={(e) => setUnknownOnly(e.target.checked)}
              />
              Unknown only
            </label>
          </div>

          {advancedFiltersOpen && (
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                IP / CIDR / range
                <input
                  type="text"
                  value={ipFilter}
                  onChange={(e) => setIpFilter(e.target.value)}
                  className="rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
                  placeholder="10.0.0.0/24 or 10.0.0.1-10.0.0.20"
                />
              </label>
              <select
                className="rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
              >
                <option value="none">No grouping</option>
                <option value="site">Group by site</option>
                <option value="status">Group by status</option>
              </select>
              <select
                className="rounded border-gray-300 text-sm focus:border-blue-500 focus:ring-blue-500"
                value={sortConfig.key}
                onChange={(e) => setSortKey(e.target.value)}
              >
                <option value="hostname">Hostname</option>
                <option value="site">Site</option>
                <option value="ip">IP</option>
                <option value="os">OS</option>
                <option value="network">Network</option>
                <option value="ports">Ports</option>
                <option value="status">Status</option>
                <option value="lastSeen">Last seen</option>
              </select>
              <button
                type="button"
                className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() =>
                  setSortConfig((prev) => ({
                    key: prev.key,
                    direction: prev.direction === "asc" ? "desc" : "asc",
                  }))
                }
              >
                {sortConfig.direction === "asc" ? "⬆" : "⬇"}
              </button>
              <p className="text-xs text-gray-500">
                Combine IP, grouping, and sorting without leaving this panel.
              </p>
            </div>
          )}
        </div>
      </section>

      <section
        ref={assetsTableRef}
        className="rounded-lg border border-gray-200 bg-white shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Assets</h3>
            <p className="text-sm text-gray-500">
              Showing {filteredAssets.length ? `${pageRangeLabel}` : 0} of {" "}
              {filteredAssets.length} assets
              {selectedSiteId !== ALL_SITES.id &&
              siteOptions.find((o) => o.id === selectedSiteId)
                ? ` at ${siteOptions.find((o) => o.id === selectedSiteId)?.name}`
                : ""}
              {hiddenCount > 0 && (
                <span className="ml-2 text-amber-700">
                  ({hiddenCount} hidden by filters)
                </span>
              )}
            </p>
            {bulkStatus && (
              <p className="mt-1 text-xs text-blue-700">{bulkStatus}</p>
            )}
          </div>
          {lastUpdated && (
            <div className="text-right text-xs text-gray-500">
              <p>Inventory refreshed</p>
              <p className="font-semibold text-gray-700">
                {lastUpdated.toLocaleString()}
              </p>
            </div>
          )}
        </div>

        {selectedAssets.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-blue-50 px-4 py-2 text-xs text-blue-900">
            <span className="font-semibold">
              {selectedAssets.length} selected
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded border border-blue-300 bg-white px-3 py-1 hover:bg-blue-100"
                onClick={handleBulkConfirm}
              >
                Mark confirmed
              </button>
              <button
                type="button"
                className="rounded border border-blue-300 bg-white px-3 py-1 hover:bg-blue-100"
                onClick={handleBulkUnknown}
              >
                Filter unknown
              </button>
              <button
                type="button"
                className="rounded border border-blue-300 bg-white px-3 py-1 hover:bg-blue-100"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear selection
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 uppercase text-gray-600 shadow-sm">
              <tr>
                <th className="w-8 px-2 py-2 text-left">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all visible assets"
                  />
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                >
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => setSortKey("hostname")}
                  >
                    Hostname {sortIndicator("hostname")}
                  </button>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                >
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => setSortKey("site")}
                  >
                    Site {sortIndicator("site")}
                  </button>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                >
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => setSortKey("ip")}
                  >
                    IP {sortIndicator("ip")}
                  </button>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                >
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => setSortKey("os")}
                  >
                    OS {sortIndicator("os")}
                  </button>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                >
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => setSortKey("network")}
                  >
                    Network {sortIndicator("network")}
                  </button>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                >
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => setSortKey("ports")}
                  >
                    Ports {sortIndicator("ports")}
                  </button>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                >
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => setSortKey("status")}
                  >
                    Status {sortIndicator("status")}
                  </button>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                >
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => setSortKey("lastSeen")}
                  >
                    Last seen {sortIndicator("lastSeen")}
                  </button>
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {groupedAssets.map((asset) => {
                const statusTone =
                  asset.status === "online" || asset.status === "running"
                    ? "bg-green-50 text-green-700"
                    : asset.status === "offline" || asset.status === "stopped"
                      ? "bg-gray-100 text-gray-600"
                      : "bg-amber-50 text-amber-700";
                const rowId = assetRowId(asset);
                const portsExpanded = portExpansions[rowId];
                const extraPorts = Math.max(0, (asset.portList?.length || 0) - 3);
                const badgeTone = asset.isUnknown
                  ? "bg-amber-50 text-amber-700 border-amber-200"
                  : "bg-blue-50 text-blue-700 border-blue-200";
                const headerTone =
                  groupBy === "site"
                    ? "bg-purple-50 text-purple-800"
                    : groupBy === "status"
                      ? "bg-sky-50 text-sky-800"
                      : "bg-gray-50 text-gray-700";

                return (
                  <tr
                    key={rowId}
                    className={`text-gray-700 hover:bg-gray-50 ${
                      asset.isUnknown ? "bg-amber-25" : ""
                    }`}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        checked={selectedIds.has(rowId)}
                        onChange={() => toggleSelect(rowId)}
                        aria-label={`Select ${asset.hostname || asset.ip}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className={`h-8 w-8 rounded-full border ${badgeTone} flex items-center justify-center text-[10px] font-semibold`}>
                          {(asset.hostname || asset.ip || "?")
                            .toUpperCase()
                            .slice(0, 2)}
                        </div>
                        <div>
                          <button
                            type="button"
                            className="text-left text-sm font-semibold text-gray-900 hover:underline"
                            onClick={() => handleAssetClick(asset)}
                          >
                            {asset.hostname || "Unknown host"}
                          </button>
                          <p className="text-[11px] text-gray-500">
                            {asset.ip || "—"}
                          </p>
                          {groupBy !== "none" && (
                            <p className={`text-[10px] ${headerTone} inline-flex rounded px-2 py-0.5 font-semibold`}>
                              {groupBy === "site"
                                ? asset.siteName || asset.siteId
                                : asset.status || "Unknown"}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-gray-600">
                      <div className="flex flex-col">
                        <span className="font-semibold text-gray-800">
                          {asset.siteName}
                        </span>
                        <span className="text-[10px] text-gray-500">
                          {asset.group === "docker" ? "Docker" : asset.group}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-gray-700">
                      <span className="font-mono">{asset.ip}</span>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-gray-700">
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-gray-800">
                        {asset.os}
                        {asset.isUnknown && (
                          <span className="text-amber-600" title="Missing hostname or OS">
                            ⚠
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-gray-700">
                      <div className="flex flex-col">
                        <span className="font-semibold text-gray-800">
                          {asset.network || "—"}
                        </span>
                        <span className="text-[10px] text-gray-500">
                          {asset.interfaceName || "N/A"}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-1 text-[11px] text-gray-700">
                      <div className="flex flex-wrap items-center gap-1">
                        {asset.portList?.slice(0, 3).map((port) => (
                          <span
                            key={port}
                            className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700"
                          >
                            {port}
                          </span>
                        ))}
                        {extraPorts > 0 && (
                          <button
                            type="button"
                            className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-100"
                            onClick={() => togglePorts(rowId)}
                            title={asset.portList?.join(", ")}
                          >
                            +{extraPorts}
                          </button>
                        )}
                      </div>
                      {portsExpanded && asset.portList?.length > 0 && (
                        <div className="mt-1 max-w-xs whitespace-normal rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-700">
                          {asset.portList.join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusTone}`}
                      >
                        {asset.status || "unknown"}
                      </span>
                    </td>
                    <td
                      className="px-3 py-1 text-[11px] text-gray-600"
                      title={asset.lastSeen || "—"}
                    >
                      {asset.lastSeen || "—"}
                    </td>
                    <td className="px-3 py-1 text-[11px] text-gray-600">
                      <span className="inline-flex items-center gap-1 rounded border border-dashed border-blue-200 px-2 py-0.5 text-blue-700">
                        <span className="h-2 w-2 rounded-full bg-blue-400" />
                        SSH enrichment soon
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!groupedAssets.length && (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-sm text-gray-500"
                    colSpan={10}
                  >
                    {loading
                      ? "Loading inventory…"
                      : "No assets match your filters"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-gray-100">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page === 1}
              >
                Previous
              </button>
              <span className="text-sm text-gray-700">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() =>
                  setPage((prev) => Math.min(totalPages, prev + 1))
                }
                disabled={page >= totalPages || !filteredAssets.length}
              >
                Next
              </button>
            </div>
            <div className="text-xs text-gray-500">
              Showing {pageRangeLabel} of {filteredAssets.length} matching asset
              {filteredAssets.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
      </section>
      {activeAsset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          onClick={closeAssetDetails}
        >
          <div
            className="relative w-full max-w-3xl rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="absolute right-3 top-3 rounded p-1 text-gray-500 hover:bg-gray-100"
              onClick={closeAssetDetails}
              aria-label="Close asset details"
            >
              ✕
            </button>
            <div className="flex flex-col gap-1 pr-10">
              <h3 className="text-xl font-semibold text-gray-900">
                {activeAsset.hostname || "Unknown asset"}
              </h3>
              <p className="text-sm text-gray-600">
                {activeAsset.siteName} · {activeAsset.group} · IP{" "}
                {activeAsset.ip || "—"}
              </p>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Operating system
                </p>
                <p className="text-sm font-medium text-gray-900">
                  {activeAsset.os || "Unknown"}
                </p>
              </div>
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Status
                </p>
                <p className="text-sm font-medium text-gray-900">
                  {activeAsset.status || "Unknown"}
                </p>
              </div>
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Network
                </p>
                <p className="text-sm font-medium text-gray-900">
                  {activeAsset.network || "—"}
                </p>
              </div>
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Interface
                </p>
                <p className="text-sm font-medium text-gray-900">
                  {activeAsset.interfaceName || "—"}
                </p>
              </div>
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  MAC
                </p>
                <p className="text-sm font-medium text-gray-900">
                  {activeAsset.mac || "—"}
                </p>
              </div>
              <div className="rounded border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Last seen
                </p>
                <p className="text-sm font-medium text-gray-900">
                  {activeAsset.lastSeen || "—"}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Ports
              </p>
              {activeAsset.portList?.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {activeAsset.portList.map((port) => (
                    <span
                      key={port}
                      className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-700"
                    >
                      {port}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-600">No reported ports.</p>
              )}
            </div>

            {activeAsset.unknownReasons?.length > 0 && (
              <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <p className="font-semibold">Why flagged as unknown</p>
                <ul className="list-disc pl-5">
                  {activeAsset.unknownReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
