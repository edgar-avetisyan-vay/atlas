import { useEffect, useMemo, useState } from "react";
import { AtlasAPI } from "../api";
import { useSiteSource } from "../context/SiteSourceContext";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function relativeTime(value) {
  if (!value) return "never";
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return value;
  const deltaSeconds = Math.max(0, (Date.now() - ts) / 1000);
  if (deltaSeconds < 60) return `${Math.floor(deltaSeconds)}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86400)}d ago`;
}

function siteStatus(site) {
  const lastSignal = site?.last_seen || site?.last_heartbeat || site?.updated_at;
  const ts = lastSignal ? new Date(lastSignal).getTime() : 0;
  if (!ts || Number.isNaN(ts)) return { label: "Unreported", tone: "gray" };
  const ageMinutes = (Date.now() - ts) / (1000 * 60);
  if (ageMinutes < 10) return { label: "Active", tone: "green" };
  if (ageMinutes < 60) return { label: "Stale", tone: "amber" };
  return { label: "Offline", tone: "red" };
}

function maskTokenDisplay(token) {
  if (!token) return "Hidden";
  if (token.length <= 6) return "••••";
  return `${token.slice(0, 3)}••••${token.slice(-3)}`;
}

function toTokenRecord(token) {
  const fallbackId = token.id || `token-${token.created_at || Date.now()}`;
  return {
    id: fallbackId,
    label: token.label,
    created_at: token.created_at,
    masked: maskTokenDisplay(token.token),
  };
}

function msSince(value) {
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return Number.POSITIVE_INFINITY;
  return Date.now() - ts;
}

function describeAgentHealth(agent) {
  const heartbeatAge = msSince(agent?.last_heartbeat);
  const ingestAge = msSince(agent?.last_ingest);

  const heartbeatOk = heartbeatAge < 5 * 60 * 1000; // 5 minutes
  const ingestOk = ingestAge < 30 * 60 * 1000; // 30 minutes

  if (heartbeatOk && ingestOk) {
    return { label: "Healthy", tone: "green", detail: "Heartbeats and ingest are recent" };
  }

  if (!heartbeatOk && ingestOk) {
    return { label: "Stale heartbeat", tone: "amber", detail: "Agent is ingesting but heartbeat is late" };
  }

  if (heartbeatOk && !ingestOk) {
    return { label: "No ingest", tone: "amber", detail: "Heartbeat is alive but ingest is older than 30m" };
  }

  return { label: "Unresponsive", tone: "red", detail: "No recent heartbeat or ingest" };
}

export default function SitesPanel() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [agents, setAgents] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [createForm, setCreateForm] = useState({ site_id: "", site_name: "", description: "" });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createStatus, setCreateStatus] = useState({ loading: false, error: null, success: null });
  const [tokenFormLabel, setTokenFormLabel] = useState("");
  const [tokenStatus, setTokenStatus] = useState({ loading: false, error: null, success: null, latestToken: null });
  const [formErrors, setFormErrors] = useState({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState("updated_desc");
  const { activeSiteId, activeSiteName, setActiveSite, clearActiveSite } = useSiteSource();

  useEffect(() => {
    let timer;
    let mounted = true;

    async function loadSummary() {
      setLoading(true);
      setError(null);
      try {
        const summary = await AtlasAPI.getSiteSummary();
        if (!mounted) return;
        setSites(summary);
        if (activeSiteId) {
          const match = summary.find((s) => s.site_id === activeSiteId);
          if (match && match.site_name && match.site_name !== activeSiteName) {
            setActiveSite(match.site_id, match.site_name);
          }
        }
      } catch (err) {
        if (mounted) setError(err.message || String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadSummary();
    timer = setInterval(loadSummary, 15000);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [activeSiteId, activeSiteName, setActiveSite]);

  async function handleCreateSite(event) {
    event.preventDefault();
    const trimmedId = createForm.site_id.trim();
    const trimmedName = createForm.site_name.trim();
    const nextErrors = {};
    if (!trimmedId) {
      nextErrors.site_id = "Site ID is required";
    }
    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setCreateStatus({ loading: false, error: "Please fix the highlighted fields", success: null });
      return;
    }

    setCreateStatus({ loading: true, error: null, success: null });
    try {
      await AtlasAPI.createSite({
        site_id: trimmedId,
        site_name: trimmedName || undefined,
        description: createForm.description.trim() || undefined,
      });
      setCreateStatus({ loading: false, error: null, success: "Site saved" });
      setFormErrors({});
      setActiveSite(trimmedId, trimmedName || trimmedId);
      setCreateForm({ site_id: "", site_name: "", description: "" });
    } catch (err) {
      setCreateStatus({ loading: false, error: err.message || String(err), success: null });
    }
  }

  async function handleGenerateToken(event) {
    event.preventDefault();
    if (!activeSiteId) {
      setTokenStatus({ loading: false, error: "Select a site before generating a token", success: null, latestToken: null });
      return;
    }

    setTokenStatus({ loading: true, error: null, success: null, latestToken: null });
    try {
      const response = await AtlasAPI.createSiteToken(activeSiteId, {
        label: tokenFormLabel.trim() || undefined,
      });
      setTokenStatus({
        loading: false,
        error: null,
        success: "Token generated. Copy it into your agent environment.",
        latestToken: response.token,
      });
      setTokenFormLabel("");
      setTokens((prev) => [toTokenRecord(response), ...prev]);
    } catch (err) {
      setTokenStatus({ loading: false, error: err.message || String(err), success: null, latestToken: null });
    }
  }

  async function handleRevokeToken(tokenId) {
    if (!activeSiteId) return;
    setTokenStatus((prev) => ({ ...prev, error: null, success: null }));
    try {
      await AtlasAPI.deleteSiteToken(activeSiteId, tokenId);
      setTokens((prev) => prev.filter((token) => token.id !== tokenId));
      setTokenStatus((prev) => ({ ...prev, success: "Token revoked" }));
    } catch (err) {
      setTokenStatus((prev) => ({ ...prev, error: err.message || String(err) }));
    }
  }

  async function copyToken(value) {
    async function fallbackCopy(text) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(textarea);
      }
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        await fallbackCopy(value);
      }
      setTokenStatus((prev) => ({
        ...prev,
        error: null,
        success: "Token copied to clipboard",
        latestToken: prev.latestToken || value,
      }));
    } catch (err) {
      setTokenStatus((prev) => ({ ...prev, error: "Clipboard copy failed", success: null }));
    }
  }

  const activeSite = useMemo(
    () => sites.find((s) => s.site_id === activeSiteId) || null,
    [sites, activeSiteId]
  );

  const totals = useMemo(() => {
    const hosts = sites.reduce((sum, site) => sum + (site.host_count || 0), 0);
    const agents = sites.reduce((sum, site) => sum + (site.agent_count || 0), 0);
    const activeSites = sites.filter((site) => siteStatus(site).label === "Active").length;
    return { hosts, agents, activeSites };
  }, [sites]);

  const filteredSites = useMemo(() => {
    const searchLower = search.toLowerCase();
    let next = sites.filter((site) => {
      const status = siteStatus(site).label.toLowerCase();
      const matchesStatus = statusFilter === "all" || status === statusFilter;
      const matchesSearch =
        site.site_id.toLowerCase().includes(searchLower) ||
        (site.site_name || "").toLowerCase().includes(searchLower);
      return matchesStatus && matchesSearch;
    });

    next = next.sort((a, b) => {
      if (sortKey === "hosts") return (b.host_count || 0) - (a.host_count || 0);
      if (sortKey === "agents") return (b.agent_count || 0) - (a.agent_count || 0);
      const aTime = new Date(a.updated_at || a.last_seen || a.created_at || 0).getTime();
      const bTime = new Date(b.updated_at || b.last_seen || b.created_at || 0).getTime();
      return bTime - aTime;
    });

    return next;
  }, [sites, search, statusFilter, sortKey]);

  useEffect(() => {
    let mounted = true;
    setTokenStatus({ loading: false, error: null, success: null, latestToken: null });
    setTokenFormLabel("");
    if (!activeSiteId) {
      setAgents([]);
      setTokens([]);
      setTokenStatus({ loading: false, error: null, success: null, latestToken: null });
      return () => {
        mounted = false;
      };
    }

    async function loadDetails() {
      setDetailLoading(true);
      setDetailError(null);
      try {
        const [siteAgents, siteTokens] = await Promise.all([
          AtlasAPI.getSiteAgents(activeSiteId),
          AtlasAPI.getSiteTokens(activeSiteId),
        ]);
        if (!mounted) return;
        setAgents(siteAgents);
        setTokens(siteTokens.map((token) => toTokenRecord(token)));
      } catch (err) {
        if (mounted) setDetailError(err.message || String(err));
      } finally {
        if (mounted) setDetailLoading(false);
      }
    }

    loadDetails();

    return () => {
      mounted = false;
    };
  }, [activeSiteId]);

  return (
    <div className="h-full flex flex-col gap-4 min-h-0 overflow-y-auto pb-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Remote Sites</h2>
          <p className="text-gray-600">
            Monitor remote agents and understand which site identifiers are active. Use the Site ID in agent configs; the
            friendly name is for humans and can be updated anytime.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {loading && <span className="text-sm text-gray-500">Refreshing…</span>}
          <button
            type="button"
            onClick={() => clearActiveSite()}
            className="text-sm text-blue-700 underline decoration-dotted hover:text-blue-900"
          >
            Reset selection
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-500">Sites online</p>
          <p className="text-2xl font-semibold">{totals.activeSites}</p>
          <p className="text-xs text-gray-500">of {sites.length} registered</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-500">Agents reporting</p>
          <p className="text-2xl font-semibold">{totals.agents}</p>
          <p className="text-xs text-gray-500">based on latest heartbeats</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-500">Hosts discovered</p>
          <p className="text-2xl font-semibold">{totals.hosts}</p>
          <p className="text-xs text-gray-500">across all remote sites</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-500">Selection</p>
          <p className="text-2xl font-semibold">{activeSite ? activeSite.site_id : "—"}</p>
          <p className="text-xs text-gray-500">Click a card to focus a site</p>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          <label className="text-sm text-gray-600 flex items-center gap-2">
            <span className="font-medium">Search</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded border-gray-300 focus:border-blue-500 focus:ring-blue-500 text-sm"
              placeholder="Filter by ID or name"
            />
          </label>
          <label className="text-sm text-gray-600 flex items-center gap-2">
            <span className="font-medium">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded border-gray-300 focus:border-blue-500 focus:ring-blue-500 text-sm"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="stale">Stale</option>
              <option value="offline">Offline</option>
            </select>
          </label>
        </div>
        <label className="text-sm text-gray-600 flex items-center gap-2">
          <span className="font-medium">Sort</span>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value)}
            className="rounded border-gray-300 focus:border-blue-500 focus:ring-blue-500 text-sm"
          >
            <option value="updated_desc">Recent updates</option>
            <option value="hosts">Hosts</option>
            <option value="agents">Agents</option>
          </select>
        </label>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-50 text-red-700 border border-red-200">{error}</div>
      )}

      <section className="bg-white border border-gray-200 rounded-lg p-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Site registration</h3>
            <p className="text-sm text-gray-500">
              Share Site IDs with remote teams when they are ready. Expand the form only when you need to add or edit a site.
            </p>
          </div>
          <button
            type="button"
            className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-100"
            onClick={() => setShowCreateForm((prev) => !prev)}
          >
            {showCreateForm ? "Hide form" : "Add site"}
          </button>
        </div>

        {showCreateForm && (
          <>
            {createStatus.error && (
              <p className="mt-3 text-sm text-red-600 border border-red-200 bg-red-50 rounded p-2">{createStatus.error}</p>
            )}
            {createStatus.success && (
              <p className="mt-3 text-sm text-green-700 border border-green-200 bg-green-50 rounded p-2">{createStatus.success}</p>
            )}
            <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={handleCreateSite}>
              <label className="flex flex-col text-sm font-medium text-gray-700">
                Site ID <span className="text-red-600">*</span>
                <input
                  type="text"
                  value={createForm.site_id}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, site_id: e.target.value }))}
                  className={`mt-1 rounded focus:border-blue-500 focus:ring-blue-500 ${
                    formErrors.site_id ? "border-red-400" : "border-gray-300"
                  }`}
                  placeholder="branch-001"
                  required
                />
                <span className="text-xs text-gray-500 mt-1">
                  Agents should send this exact ID (e.g., <code>ATLAS_SITE_ID</code>), while friendly names are just labels.
                </span>
                {formErrors.site_id && <span className="text-xs text-red-600 mt-1">{formErrors.site_id}</span>}
              </label>
              <label className="flex flex-col text-sm font-medium text-gray-700">
                Friendly name
                <input
                  type="text"
                  value={createForm.site_name}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, site_name: e.target.value }))}
                  className="mt-1 rounded border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                  placeholder="Branch Office"
                />
                <span className="text-xs text-gray-500 mt-1">Shown in the UI; keep it descriptive for analysts.</span>
              </label>
              <label className="flex flex-col text-sm font-medium text-gray-700 md:col-span-2">
                Notes
                <textarea
                  value={createForm.description}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, description: e.target.value }))}
                  className="mt-1 rounded border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                  rows="2"
                  placeholder="Optional context or escalation contacts"
                />
              </label>
              <div className="md:col-span-2 flex items-center justify-end text-xs text-gray-500 gap-3">
                {createStatus.loading && <span className="text-xs text-gray-400">Saving…</span>}
                <button
                  type="submit"
                  className="inline-flex items-center rounded bg-blue-600 px-4 py-2 text-white text-sm font-semibold disabled:opacity-50"
                  disabled={createStatus.loading}
                >
                  Save site
                </button>
              </div>
            </form>
          </>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 overflow-y-auto max-h-64 pr-1 shrink-0">
        {filteredSites.length === 0 && !loading && (
          <div className="col-span-full border border-dashed rounded-lg p-6 bg-white text-center text-sm text-gray-600">
            No sites reported yet. Add a site ID or wait for an agent ingest to appear here.
          </div>
        )}
        {filteredSites.map((site) => {
          const isActive = activeSiteId === site.site_id;
          const status = siteStatus(site);
          const tone =
            status.tone === "green"
              ? "text-green-700 bg-green-50 border-green-200"
              : status.tone === "amber"
                ? "text-amber-700 bg-amber-50 border-amber-200"
                : status.tone === "red"
                  ? "text-red-700 bg-red-50 border-red-200"
                  : "text-gray-700 bg-gray-50 border-gray-200";
          return (
            <button
              type="button"
              key={site.site_id}
              onClick={() => (isActive ? clearActiveSite() : setActiveSite(site.site_id, site.site_name))}
              className={`text-left border rounded-lg p-4 shadow-sm transition hover:shadow-md ${
                isActive ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white"
              }`}
            >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm uppercase tracking-wide text-gray-500">{site.site_id}</p>
                <p className="text-lg font-semibold">{site.site_name}</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-blue-600">{site.host_count}</p>
                <p className="text-xs text-gray-500">Hosts discovered</p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-semibold ${tone}`}>
                <span className="h-2 w-2 rounded-full bg-current opacity-70" />
                {status.label}
              </span>
              <span className="text-xs text-gray-500">Updated {relativeTime(site.updated_at)}</span>
            </div>
            {site.description && (
              <p className="mt-2 text-sm text-gray-600 break-words">{site.description}</p>
            )}
            <dl className="mt-3 text-sm text-gray-600 space-y-1">
              <div className="flex justify-between">
                <dt>Agents</dt>
                <dd>{site.agent_count || 0}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Last Seen</dt>
                <dd>{relativeTime(site.last_seen)}</dd>
              </div>
            </dl>
            </button>
          );
        })}
      </div>

      <div className="flex-1 grid gap-4 lg:grid-cols-5 min-h-0">
        <section className="bg-white rounded-lg border border-gray-200 flex flex-col lg:col-span-2 min-h-0">
          <header className="p-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Agent tokens</h3>
              <p className="text-sm text-gray-500">
                Generate bearer tokens for agents posting to {activeSite ? activeSite.site_id : "this site"}.
              </p>
            </div>
            {tokenStatus.loading && <span className="text-xs text-gray-400">Working…</span>}
          </header>

          <div className="flex-1 flex flex-col">
            {tokenStatus.error && (
              <p className="px-4 pt-4 text-sm text-red-600">{tokenStatus.error}</p>
            )}
            {tokenStatus.success && (
              <p className="px-4 pt-4 text-sm text-green-700">{tokenStatus.success}</p>
            )}
            {tokenStatus.latestToken && (
              <div className="mx-4 mt-3 mb-1 p-3 rounded border border-blue-200 bg-blue-50">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-blue-900 font-medium">Newest token</p>
                    <p className="font-mono text-xs break-all text-blue-900">{tokenStatus.latestToken}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToken(tokenStatus.latestToken)}
                    className="shrink-0 inline-flex items-center rounded bg-blue-600 px-3 py-1 text-white text-xs font-semibold"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-xs text-blue-800 mt-2">
                  Paste into <code className="font-mono">ATLAS_AGENT_TOKEN</code> for your agent container. Tokens are only shown
                  once—store it securely now.
                </p>
              </div>
            )}

            <form className="px-4 py-3 border-b border-gray-100 flex flex-col gap-3" onSubmit={handleGenerateToken}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
                <label className="flex-1 text-sm text-gray-700 font-medium">
                  Token label (optional)
                  <input
                    type="text"
                    value={tokenFormLabel}
                    onChange={(e) => setTokenFormLabel(e.target.value)}
                    className="mt-1 w-full rounded border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                    placeholder="edge01 or branch gateway"
                    disabled={!activeSiteId}
                  />
                </label>
                <button
                  type="submit"
                  className="inline-flex items-center justify-center rounded bg-blue-600 px-4 py-2 text-white text-sm font-semibold disabled:opacity-50"
                  disabled={!activeSiteId || tokenStatus.loading}
                >
                  Generate token
                </button>
              </div>
              {!activeSiteId && (
                <p className="text-xs text-gray-500">Select a site above to mint new agent tokens.</p>
              )}
            </form>

            <div className="px-4 pb-4 flex-1 flex">
              <ul className="divide-y rounded border border-gray-200 bg-gray-50 w-full max-h-56 overflow-auto self-start">
                {tokens.map((token) => (
                  <li key={token.id} className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs break-all text-gray-900">{token.masked}</p>
                      <p className="text-xs text-gray-500">
                        {token.label || "Agent token"} · Created {formatDate(token.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-gray-500">Hidden after creation</span>
                      <button
                        type="button"
                        onClick={() => handleRevokeToken(token.id)}
                        className="inline-flex items-center rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100"
                        disabled={tokenStatus.loading}
                      >
                        Revoke
                      </button>
                    </div>
                  </li>
                ))}
                {!tokens.length && (
                  <li className="p-4 text-sm text-gray-500 text-center flex items-center justify-center h-full">
                    {activeSiteId ? "No tokens yet — generate one to deploy an agent." : "Select a site to manage tokens."}
                  </li>
                )}
              </ul>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-lg border border-gray-200 flex flex-col lg:col-span-3 min-h-0">
          <header className="p-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Agents</h3>
              <p className="text-sm text-gray-500">{activeSite ? activeSite.site_id : "Select a site"}</p>
            </div>
            {detailLoading && <span className="text-xs text-gray-400">Loading…</span>}
          </header>
          {detailError && (
            <p className="px-4 pt-3 text-sm text-red-600">{detailError}</p>
          )}
          <div className="flex-1 overflow-auto flex">
            <ul className="divide-y flex-1 self-start">
              {agents.map((agent) => {
                const health = describeAgentHealth(agent);
                const toneClass = health.tone === "green"
                  ? "bg-green-100 text-green-800 border-green-200"
                  : health.tone === "amber"
                    ? "bg-amber-100 text-amber-800 border-amber-200"
                    : "bg-red-100 text-red-800 border-red-200";

                return (
                  <li key={agent.agent_id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold break-words">{agent.agent_id}</p>
                        <p className="text-xs text-gray-500">Version: {agent.agent_version || "unknown"}</p>
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${toneClass}`}>
                            <span className="h-2 w-2 rounded-full bg-current opacity-75" />
                            {health.label}
                          </span>
                          <span className="text-xs text-gray-500">{health.detail}</span>
                        </div>
                      </div>
                      <span className="text-xs text-gray-500">{relativeTime(agent.last_heartbeat)}</span>
                    </div>
                    <dl className="mt-2 text-xs text-gray-600 grid grid-cols-2 gap-2">
                      <div>
                        <dt className="uppercase tracking-wide">Last Ingest</dt>
                        <dd>{formatDate(agent.last_ingest)}</dd>
                      </div>
                      <div>
                        <dt className="uppercase tracking-wide">Heartbeat</dt>
                        <dd>{formatDate(agent.last_heartbeat)}</dd>
                      </div>
                      <div>
                        <dt className="uppercase tracking-wide">Status</dt>
                        <dd>{agent.status || agent.state || "—"}</dd>
                      </div>
                      <div>
                        <dt className="uppercase tracking-wide">Location</dt>
                        <dd>{agent.hostname || agent.source_host || "unknown"}</dd>
                      </div>
                    </dl>
                    {(agent.last_error || agent.message) && (
                      <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                        {agent.last_error || agent.message}
                      </p>
                    )}
                  </li>
                );
              })}
              {!agents.length && (
                <li className="p-6 text-sm text-gray-500 flex items-center justify-center">
                  {activeSiteId ? "No agents have reported in yet" : "Select a site"}
                </li>
              )}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
