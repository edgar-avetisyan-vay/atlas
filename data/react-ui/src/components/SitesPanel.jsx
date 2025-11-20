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
  const [hosts, setHosts] = useState([]);
  const [agents, setAgents] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [createForm, setCreateForm] = useState({ site_id: "", site_name: "", description: "" });
  const [createStatus, setCreateStatus] = useState({ loading: false, error: null, success: null });
  const [tokenFormLabel, setTokenFormLabel] = useState("");
  const [tokenStatus, setTokenStatus] = useState({ loading: false, error: null, success: null, latestToken: null });
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
    if (!trimmedId) {
      setCreateStatus({ loading: false, error: "Site ID is required", success: null });
      return;
    }

    setCreateStatus({ loading: true, error: null, success: null });
    try {
      await AtlasAPI.createSite({
        site_id: trimmedId,
        site_name: createForm.site_name.trim() || undefined,
        description: createForm.description.trim() || undefined,
      });
      setCreateStatus({ loading: false, error: null, success: "Site saved" });
      setActiveSite(trimmedId, createForm.site_name.trim() || trimmedId);
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

  useEffect(() => {
    let mounted = true;
    setTokenStatus({ loading: false, error: null, success: null, latestToken: null });
    setTokenFormLabel("");
    if (!activeSiteId) {
      setHosts([]);
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
        const [siteHosts, siteAgents, siteTokens] = await Promise.all([
          AtlasAPI.getSiteHosts(activeSiteId),
          AtlasAPI.getSiteAgents(activeSiteId),
          AtlasAPI.getSiteTokens(activeSiteId),
        ]);
        if (!mounted) return;
        setHosts(siteHosts);
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Remote Sites</h2>
          <p className="text-gray-600">
            Multi-agent ingestion overview. Deploy the Go scanner remotely and POST to the
            <code className="mx-1">{"/sites/{site}/agents/{agent}/ingest"}</code>
            endpoint to populate this dashboard.
          </p>
        </div>
        {loading && <span className="text-sm text-gray-500">Refreshing…</span>}
      </div>

      {error && (
        <div className="p-3 rounded bg-red-50 text-red-700 border border-red-200">{error}</div>
      )}

      <section className="bg-white border border-gray-200 rounded-lg p-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Register a site ahead of deployment</h3>
            <p className="text-sm text-gray-500">
              Create placeholders for each location so you can share IDs with remote teams before the agents come online.
            </p>
          </div>
          {createStatus.loading && <span className="text-xs text-gray-400">Saving…</span>}
        </div>
        {createStatus.error && (
          <p className="mt-3 text-sm text-red-600 border border-red-200 bg-red-50 rounded p-2">{createStatus.error}</p>
        )}
        {createStatus.success && (
          <p className="mt-3 text-sm text-green-700 border border-green-200 bg-green-50 rounded p-2">{createStatus.success}</p>
        )}
        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={handleCreateSite}>
          <label className="flex flex-col text-sm font-medium text-gray-700">
            Site ID
            <input
              type="text"
              value={createForm.site_id}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, site_id: e.target.value }))}
              className="mt-1 rounded border-gray-300 focus:border-blue-500 focus:ring-blue-500"
              placeholder="branch-001"
              required
            />
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
          <div className="md:col-span-2 flex items-center justify-between text-xs text-gray-500">
            <p>
              Agents should target
              <code className="mx-1">{"/api/sites/{site}/agents/{agent}/ingest"}</code>
              with the Site ID shown here.
            </p>
            <button
              type="submit"
              className="inline-flex items-center rounded bg-blue-600 px-4 py-2 text-white text-sm font-semibold disabled:opacity-50"
              disabled={createStatus.loading}
            >
              Save site
            </button>
          </div>
        </form>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 overflow-y-auto max-h-64 pr-1 shrink-0">
        {sites.length === 0 && !loading && (
          <div className="col-span-full border border-dashed rounded-lg p-6 bg-white">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 flex items-center justify-center rounded-full bg-blue-50 text-2xl">
                🌐
              </div>
              <div>
                <p className="text-lg font-semibold text-gray-800">Deploy your first remote site</p>
                <p className="text-sm text-gray-500">
                  Build the slim agent (`Dockerfile.agent`) and point it at this controller to populate the Sites dashboard.
                </p>
              </div>
              <ol className="text-left text-sm text-gray-600 space-y-1">
                <li>
                  <span className="font-medium text-gray-800">1.</span> `docker build -f Dockerfile.agent -t atlas-agent .`
                </li>
                <li>
                  <span className="font-medium text-gray-800">2.</span> `docker run -d --network host --cap-add NET_RAW --cap-add NET_ADMIN \`
                  <br />
                  <span className="ml-6">-e ATLAS_CONTROLLER_URL=https://controller/api -e ATLAS_SITE_ID=branch-001 \</span>
                  <br />
                  <span className="ml-6">-e ATLAS_AGENT_INTERVAL=30m -e ATLAS_AGENT_ID=edge01 atlas-agent`</span>
                </li>
                <li>
                  <span className="font-medium text-gray-800">3.</span> Use `SCAN_SUBNETS="192.168.10.0/24"` if the auto-detected CIDR
                  needs overriding.
                </li>
              </ol>
              <p className="text-xs text-gray-500">
                Agents post to
                <code className="mx-1">{"/api/sites/{site}/agents/{agent}/ingest"}</code>. Heartbeats show up here within a few
                seconds of the first ingest.
              </p>
              <p className="text-xs text-gray-500">
                Remote agents stay running and default to a 15 minute loop. Override it with
                <code className="mx-1">ATLAS_AGENT_INTERVAL=5m</code>
                or add
                <code className="mx-1">ATLAS_AGENT_ONCE=1</code>
                to perform a single scan.
              </p>
            </div>
          </div>
        )}
        {sites.map((site) => {
          const isActive = activeSiteId === site.site_id;
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
              <span className="text-2xl font-bold text-blue-600">{site.host_count}</span>
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
                <dt>Updated</dt>
                <dd>{relativeTime(site.updated_at)}</dd>
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

      <div className="flex-1 grid gap-4 md:grid-cols-5 min-h-0 overflow-hidden">
        <section className="md:col-span-3 bg-white rounded-lg border border-gray-200 flex flex-col overflow-hidden min-h-0">
          <header className="p-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Hosts</h3>
              <p className="text-sm text-gray-500">
                {activeSite
                  ? `${activeSite.host_count} hosts at ${activeSite.site_name}`
                  : activeSiteId
                    ? `Loading ${activeSiteName || activeSiteId}…`
                    : "Select a site"}
              </p>
            </div>
            {detailLoading && <span className="text-xs text-gray-400">Loading…</span>}
          </header>
          {detailError && (
            <p className="p-3 text-sm text-red-600 border-b border-red-200 bg-red-50">{detailError}</p>
          )}
          <div className="flex-1 overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 uppercase text-xs">
                <tr>
                  <th className="text-left px-4 py-2">IP</th>
                  <th className="text-left px-4 py-2">Hostname</th>
                  <th className="text-left px-4 py-2">OS</th>
                  <th className="text-left px-4 py-2">Ports</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map((host) => (
                  <tr key={`${host.site_id}-${host.agent_id}-${host.ip}`} className="border-b last:border-0">
                    <td className="px-4 py-2 font-mono text-xs text-gray-900">
                      <div>{host.ip}</div>
                      <div className="text-gray-500">{host.agent_id}</div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{host.hostname || "—"}</div>
                      {host.mac && <div className="text-xs text-gray-500">{host.mac}</div>}
                    </td>
                    <td className="px-4 py-2">{host.os || "Unknown"}</td>
                    <td className="px-4 py-2">
                      {host.ports && host.ports.length ? (
                        <div className="flex flex-wrap gap-1">
                          {host.ports.map((port) => (
                            <span
                              key={`${host.ip}-${port.port}-${port.protocol}`}
                              className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
                            >
                              {port.port}/{port.protocol}
                              {port.service ? ` (${port.service})` : ""}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!hosts.length && (
                  <tr>
                    <td colSpan="4" className="text-center text-gray-500 py-6">
                      {activeSiteId ? "No hosts reported" : "Choose a site to inspect hosts"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="md:col-span-2 flex flex-col gap-4 min-h-0">
          <div className="bg-white rounded-lg border border-gray-200 flex flex-col shrink-0">
            <header className="p-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">Agent tokens</h3>
                <p className="text-sm text-gray-500">
                  Generate bearer tokens for agents posting to {activeSite ? activeSite.site_id : "this site"}.
                </p>
              </div>
              {tokenStatus.loading && <span className="text-xs text-gray-400">Working…</span>}
            </header>

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

            <form className="p-4 grid gap-3 md:grid-cols-3" onSubmit={handleGenerateToken}>
              <label className="md:col-span-2 flex flex-col text-sm font-medium text-gray-700">
                Label (optional)
                <input
                  type="text"
                  value={tokenFormLabel}
                  onChange={(e) => setTokenFormLabel(e.target.value)}
                  className="mt-1 rounded border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                  placeholder="edge01 or branch gateway"
                  disabled={!activeSiteId}
                />
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  className="inline-flex items-center justify-center rounded bg-blue-600 px-4 py-2 text-white text-sm font-semibold disabled:opacity-50"
                  disabled={!activeSiteId || tokenStatus.loading}
                >
                  Generate token
                </button>
              </div>
            </form>

            <div className="px-4 pb-4">
              <ul className="divide-y rounded border border-gray-200 bg-gray-50 max-h-56 overflow-auto">
                {tokens.map((token) => (
                  <li key={token.id} className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs break-all text-gray-900">{token.masked}</p>
                      <p className="text-xs text-gray-500">
                        {token.label || "Agent token"} · {formatDate(token.created_at)}
                      </p>
                    </div>
                    <span className="text-xs text-gray-500">Hidden after creation</span>
                  </li>
                ))}
                {!tokens.length && (
                  <li className="p-3 text-sm text-gray-500 text-center">
                    {activeSiteId ? "No tokens yet — generate one to deploy an agent." : "Select a site to manage tokens."}
                  </li>
                )}
              </ul>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 flex flex-col flex-1 min-h-0">
            <header className="p-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold">Agents</h3>
              <p className="text-sm text-gray-500">{activeSite ? activeSite.site_id : "Select a site"}</p>
            </header>
            <div className="flex-1 overflow-auto">
              <ul className="divide-y">
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
                  <li className="p-4 text-sm text-gray-500">
                    {activeSiteId ? "No agents have reported in yet" : "Select a site"}
                  </li>
                )}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
