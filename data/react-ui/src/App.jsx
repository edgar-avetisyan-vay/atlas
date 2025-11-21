import React, { useMemo, useRef, useState } from "react";
import { NetworkMap } from "./components/NetworkMap";
import { HostsTable } from "./components/HostsTable";
import { LogsPanel } from "./components/LogsPanel";
import InventoryPanel from "./components/InventoryPanel";
import { useNetworkStats } from "./hooks/useNetworkStats";
import BuildTag from "./components/BuildTag";
import MobileHeader from "./components/MobileHeader";
import LoginModal from "./components/LoginModal";
import SitesPanel from "./components/SitesPanel";
import { useSiteSource } from "./context/SiteSourceContext";
// Theme toggle removed per request

const tabs = ["Network Map", "Hosts Table", "Inventory", "Sites", "Logs"];

// Simple inline SVG icons (no external deps)
function TabIcon({ tab, className = "w-6 h-6" }) {
  const common = "fill-current";
  switch (tab) {
    case "Network Map":
      return (
        <svg viewBox="0 0 24 24" className={`${className} ${common}`}> 
          <path d="M6 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm12 12a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM6 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm12-12a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM8.5 7.5l7 9M8.5 16.5l7-9" stroke="currentColor" strokeWidth="1.5" fill="none"/>
        </svg>
      );
    case "Hosts Table":
      return (
        <svg viewBox="0 0 24 24" className={`${className} ${common}`}>
          <path d="M3 5h18v4H3zM3 10.5h18M3 15h18M3 19h18" stroke="currentColor" strokeWidth="1.5" fill="none"/>
        </svg>
      );
    case "Inventory":
      return (
        <svg viewBox="0 0 24 24" className={`${className} ${common}`}>
          <rect x="3" y="4" width="18" height="16" rx="2" ry="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M3 9h18M8 13h8M8 17h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "Sites":
      return (
        <svg viewBox="0 0 24 24" className={`${className} ${common}`}>
          <path
            d="M4 5h16v6H4zM6 11v8h4v-5h4v5h4v-8"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <path d="M2 21h20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "Logs":
      return (
        <svg viewBox="0 0 24 24" className={`${className} ${common}`}>
          <path d="M4 5h16v14H4z" fill="none" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M7 8h10M7 12h10M7 16h6" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
      );
    default:
      return null;
  }
}

function Sidebar({ activeTab, setActiveTab, visible, setVisible, onShowDuplicates }) {
  const sidebarRef = useRef(null);

  return (
    <>
      {/* Overlay (mobile only) */}
      {visible && (
        <div
          className="fixed inset-0 bg-black/40 z-30 lg:hidden"
          onClick={() => setVisible(false)}
        ></div>
      )}

      {/* Sidebar container (mobile: slide-over, desktop: collapsible rail) */}
      <div
        className={`z-40 top-0 left-0 bg-gray-900 text-white flex flex-col transition-all duration-300
        fixed h-full w-64 transform ${visible ? "translate-x-0" : "-translate-x-full"} lg:static lg:h-auto lg:transform-none
        ${visible ? "lg:w-64" : "lg:w-16"}`}
        ref={sidebarRef}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4 px-4 py-3">
          <div className={`flex items-center space-x-2 ${visible ? "lg:flex" : "lg:hidden"}`}>
            <h1 className="text-xl font-bold">Atlas</h1>
            <BuildTag />
          </div>
          {/* Close (mobile) */}
          <button
            className="lg:hidden text-gray-300 hover:text-white"
            onClick={() => setVisible(false)}
          >
            ✕
          </button>
        </div>

        {/* Single nav list with animated icon-to-label transition */}
        <div className="px-2 py-1 flex-1 overflow-y-auto">
          <div className="space-y-2">
            {tabs.map((tab) => (
              <div key={tab} className="relative group">
                <button
                  onClick={() => {
                    setActiveTab(tab);
                    if (window.innerWidth < 1024) setVisible(false);
                  }}
                  title={tab}
                  aria-label={tab}
                  className={`w-full flex items-center ${visible ? "justify-start" : "justify-center"} p-2 rounded transition-colors duration-200 ${
                    activeTab === tab ? "bg-gray-700" : "hover:bg-gray-800"
                  }`}
                >
                  <TabIcon tab={tab} />
                  <span
                    className={`overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${
                      visible ? "opacity-100 ml-3 w-auto" : "opacity-0 ml-0 w-0"
                    }`}
                  >
                    {tab}
                  </span>
                </button>
                {!visible && (
                  <span className="pointer-events-none absolute left-14 top-1/2 -translate-y-1/2 rounded bg-black text-white text-xs px-2 py-1 opacity-0 group-hover:opacity-100 shadow-lg">
                    {tab}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function NetworkStatsBar({ onShowDuplicates }) {
  const stats = useNetworkStats();

  const statCards = [
    { label: "Total hosts", value: stats.total, detail: stats.remoteHosts ? `+${stats.remoteHosts} remote` : null },
    { label: "Docker", value: `${stats.dockerRunning}/${stats.docker}`, detail: "running/total" },
    { label: "Subnets", value: stats.subnets, detail: "unique" },
    { label: "Remote", value: `${stats.remoteSites} sites`, detail: `${stats.remoteAgents} agents` },
    { label: "Duplicates", value: stats.duplicateIps, detail: "IP collisions", action: onShowDuplicates },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 mb-4">
      {statCards.map((card) => (
        <button
          key={card.label}
          type="button"
          onClick={card.action}
          className={`rounded-lg border bg-white px-4 py-3 text-left shadow-sm transition ${
            card.action ? "hover:shadow-md hover:border-blue-300" : "cursor-default"
          }`}
        >
          <p className="text-xs uppercase tracking-wide text-gray-500">{card.label}</p>
          <p className="text-xl font-semibold text-gray-900">{card.value || "—"}</p>
          <p className="text-xs text-gray-500">{card.detail || stats.updatedAt || "live"}</p>
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("Network Map");
  const [selectedNode, setSelectedNode] = useState(null);
  // Default: collapsed on desktop, hidden on mobile
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [loginVisible, setLoginVisible] = useState(false);
  const [hostsShowDuplicates, setHostsShowDuplicates] = useState(false);
  const { activeSiteId, activeSiteName, clearActiveSite, isRemoteSource } = useSiteSource();
  const activeSiteLabel = activeSiteName || activeSiteId;

  const openLogin = () => setLoginVisible(true);
  const closeLogin = () => setLoginVisible(false);

  return (
    <div className="flex flex-col h-screen bg-gray-100 relative">
      {/* Mobile Header - only visible on mobile; pass menu opener */}
      <MobileHeader onOpenMenu={() => setSidebarVisible(true)} onOpenLogin={openLogin} />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          visible={sidebarVisible}
          setVisible={setSidebarVisible}
          onShowDuplicates={() => {
            setActiveTab("Hosts Table");
            setHostsShowDuplicates(true);
          }}
        />

        <div className="flex-1 p-6 overflow-hidden flex flex-col">
          {/* Top bar */}
          <div className="flex items-center justify-between mb-4 shrink-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="hidden lg:inline-flex items-center gap-2 rounded border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
                onClick={() => setSidebarVisible((prev) => !prev)}
                aria-pressed={sidebarVisible}
                aria-label={sidebarVisible ? "Collapse navigation" : "Expand navigation"}
              >
                ☰
                <span className="hidden xl:inline">{sidebarVisible ? "Hide menu" : "Show menu"}</span>
              </button>
            </div>

            {/* Right: desktop-only login button (placeholder for real auth) */}
            <div className="flex items-center">
              <button
                className="hidden lg:inline-flex bg-transparent text-gray-700 hover:text-gray-900 p-2 rounded-md"
                title="Login"
                aria-label="Login"
                onClick={openLogin}
              >
                <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current" role="img" aria-hidden="true">
                  <circle cx="12" cy="8" r="4" fill="currentColor" />
                  <path d="M4 20c0-4 3.6-7.3 8-7.3s8 3.3 8 7.3" stroke="currentColor" strokeWidth="2" fill="none" />
                </svg>
              </button>
            </div>
          </div>

          {isRemoteSource && activeSiteLabel && (
            <div className="mb-4 shrink-0 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900">
              <span>
                Showing remote data from <span className="font-semibold">{activeSiteLabel}</span>.
              </span>
              <button
                type="button"
                className="text-blue-800 underline decoration-dotted hover:text-blue-900"
                onClick={clearActiveSite}
              >
                Reset to controller data
              </button>
            </div>
          )}

          {/* Content area fills remaining height; individual tabs handle their own internal scroll */}
          <div className="w-full h-full flex-1 min-h-0">
            {activeTab === "Inventory" && (
              <NetworkStatsBar
                onShowDuplicates={() => {
                  setActiveTab("Hosts Table");
                  setHostsShowDuplicates(true);
                }}
              />
            )}
            {activeTab === "Network Map" && (
              <NetworkMap onNodeSelect={setSelectedNode} selectedNode={selectedNode} />
            )}
            {activeTab === "Hosts Table" && (
              <HostsTable
                selectedNode={selectedNode}
                onSelectNode={setSelectedNode}
                showDuplicates={hostsShowDuplicates}
                onClearPreset={() => setHostsShowDuplicates(false)}
              />
            )}
            {activeTab === "Inventory" && <InventoryPanel />}
            {activeTab === "Sites" && <SitesPanel />}
            {activeTab === "Logs" && <LogsPanel />}
          </div>
        </div>
      </div>
      <LoginModal open={loginVisible} onClose={closeLogin} />
    </div>
  );
}
