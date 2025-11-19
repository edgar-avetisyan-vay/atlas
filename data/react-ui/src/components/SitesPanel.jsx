import { useEffect, useMemo, useState } from "react";
import { AtlasAPI } from "../api";

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

export default function SitesPanel() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedSite, setSelectedSite] = useState(null);
  const [hosts, setHosts] = useState([]);
  const [agents, setAgents] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [createForm, setCreateForm] = useState({ site_id: "", site_name: "", description: "" });
  const [createStatus, setCreateStatus] = useState({ loading: false, error: null, success: null });

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
        if (!selectedSite && summary.length) {
          setSelectedSite(summary[0].site_id);
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
  }, [selectedSite]);

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
      setSelectedSite(trimmedId);
      setCreateForm({ site_id: "", site_name: "", description: "" });
    } catch (err) {
      setCreateStatus({ loading: false, error: err.message || String(err), success: null });
    }
  }

  const activeSite = useMemo(
    () => sites.find((s) => s.site_id === selectedSite) || null,
    [sites, selectedSite]
  );

  useEffect(() => {
    let mounted = true;
    if (!selectedSite) {
      setHosts([]);
      setAgents([]);
      return () => {
        mounted = false;
      };
    }

    async function loadDetails() {
      setDetailLoading(true);
      setDetailError(null);
      try {
        const [siteHosts, siteAgents] = await Promise.all([
          AtlasAPI.getSiteHosts(selectedSite),
          AtlasAPI.getSiteAgents(selectedSite),
        ]);
        if (!mounted) return;
        setHosts(siteHosts);
        setAgents(siteAgents);
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
  }, [selectedSite]);

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Remote Sites</h2>
          <p className="text-gray-600">
            Multi-agent ingestion overview. Deploy the Go scanner remotely and POST to the new
            /sites/{{site}}/agents/{{agent}}/ingest endpoint to populate this dashboard.
          </p>
        </div>
        {loading && <span className="text-sm text-gray-500">Refreshing…</span>}
      </div>

      {error && (
        <div className="p-3 rounded bg-red-50 text-red-700 border border-red-200">{error}</div>
      )}

      <section className="bg-white border border-gray-200 rounded-lg p-4">
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
            <p>Agents should target `/api/sites/{{site}}/agents/{{agent}}/ingest` with the Site ID shown here.</p>
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 overflow-y-auto max-h-60 pr-1">
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
                  <span className="ml-6">-e ATLAS_AGENT_ID=edge01 atlas-agent`</span>
                </li>
                <li>
                  <span className="font-medium text-gray-800">3.</span> Use `SCAN_SUBNETS="192.168.10.0/24"` if the auto-detected CIDR
                  needs overriding.
                </li>
              </ol>
              <p className="text-xs text-gray-500">
                Agents post to `/api/sites/{{site}}/agents/{{agent}}/ingest`. Heartbeats show up here within a few seconds of the
                first ingest.
              </p>
            </div>
          </div>
        )}
        {sites.map((site) => (
          <button
            type="button"
            key={site.site_id}
            onClick={() => setSelectedSite(site.site_id)}
            className={`text-left border rounded-lg p-4 shadow-sm transition hover:shadow-md ${
              selectedSite === site.site_id ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white"
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
        ))}
      </div>

      <div className="flex-1 grid gap-4 md:grid-cols-5 min-h-0">
        <section className="md:col-span-3 bg-white rounded-lg border border-gray-200 flex flex-col overflow-hidden">
          <header className="p-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Hosts</h3>
              <p className="text-sm text-gray-500">
                {activeSite ? `${activeSite.host_count} hosts at ${activeSite.site_name}` : "Select a site"}
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
                      {selectedSite ? "No hosts reported" : "Choose a site to inspect hosts"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="md:col-span-2 bg-white rounded-lg border border-gray-200 flex flex-col">
          <header className="p-4 border-b border-gray-100">
            <h3 className="text-lg font-semibold">Agents</h3>
            <p className="text-sm text-gray-500">{activeSite ? activeSite.site_id : "Select a site"}</p>
          </header>
          <div className="flex-1 overflow-auto">
            <ul className="divide-y">
              {agents.map((agent) => (
                <li key={agent.agent_id} className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">{agent.agent_id}</p>
                      <p className="text-xs text-gray-500">Version: {agent.agent_version || "unknown"}</p>
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
                  </dl>
                </li>
              ))}
              {!agents.length && (
                <li className="p-4 text-sm text-gray-500">
                  {selectedSite ? "No agents have reported in yet" : "Select a site"}
                </li>
              )}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
