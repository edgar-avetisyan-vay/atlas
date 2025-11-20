import { useEffect, useState, useRef, useMemo } from "react";
import { apiGet, sseUrl, API_BASE_URL } from "../api";

// Custom searchable dropdown for log files
function LogFileDropdown({ files, value, onChange }) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef();

  // Filter files by search
  const filteredFiles = useMemo(() => {
    if (!search) return files;
    const lower = search.toLowerCase();
    return files.filter(f => f.toLowerCase().includes(lower));
  }, [files, search]);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [open]);

  // Show label for selected file (same logic as before)
  const label = value
    ? value.startsWith("container:")
      ? `(Container) ${value.replace("container:", "")}`
      : value
    : "";

  return (
    <div className="relative min-w-[220px] max-w-[50%]" ref={ref}>
      <input
        className="bg-gray-800 text-white px-2 py-1 rounded w-full border border-gray-600"
        placeholder="Select Log..."
        value={open ? search : label}
        onChange={e => setSearch(e.target.value)}
        onFocus={() => setOpen(true)}
        // onClick={() => setOpen(o => !o)}
        readOnly={!open}
      />
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 bg-gray-900 border border-gray-700 rounded shadow-md w-full max-h-60 overflow-auto">
          {filteredFiles.length === 0 &&
            <div className="px-2 py-2 text-sm text-gray-400">No matching logs</div>}
          {filteredFiles.map(file => {
            const fileLabel = file.startsWith("container:")
              ? `(Container) ${file.replace("container:", "")}`
              : file;
            return (
              <div
                key={file}
                className={`cursor-pointer px-2 py-2 text-sm hover:bg-gray-700 ${
                  file === value ? "bg-blue-700 text-white" : ""
                }`}
                onClick={() => {
                  onChange(file);
                  setOpen(false);
                  setSearch("");
                }}
              >
                {fileLabel}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function deriveInsights(lines = []) {
  const normalized = lines
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);
  const lower = normalized.map((line) => line.toLowerCase());

  const insights = [];
  const seen = new Set();
  const add = (key, label, detail, tone = "info") => {
    if (seen.has(key)) return;
    seen.add(key);
    insights.push({ label, detail, tone });
  };

  const localRun = normalized.find((line) => line.includes("[local-run]"));
  if (localRun) {
    add("local-run", "Local helper", "Local runner is launching a host-network deep scan.", "info");
  }

  const deepScanStart = lower.find((line) => line.includes("starting deep-scan"));
  if (deepScanStart) {
    add("deep-scan", "Deep scan starting", "Agent container is starting a discovery cycle.", "success");
  }

  const remoteStart = lower.find((line) => line.includes("starting remote agent"));
  if (remoteStart) {
    add("remote-start", "Remote agent", "Remote agent container is initializing.", "info");
  }

  const containerId = normalized.find((line) => /^[0-9a-f]{12,64}$/i.test(line));
  if (containerId) {
    add(
      "container-id",
      "Container running",
      `Agent container ${containerId.slice(0, 12)}… is active.`,
      "muted"
    );
  }

  const followLogs = lower.find((line) => line.includes("docker logs -f"));
  if (followLogs) {
    add("follow", "Follow runtime logs", "Run docker logs -f atlas-agent-local for verbose output.", "muted");
  }

  const readyLine = lower.find(
    (line) =>
      line.includes("agent started") ||
      line.includes("ready") ||
      line.includes("listening") ||
      line.includes("scan complete") ||
      line.includes("scan finished")
  );
  if (readyLine) {
    add("ready", "Agent ready", normalized[lower.indexOf(readyLine)] || "Agent started successfully.", "success");
  }

  const errors = normalized.filter((line) => /error|fail|denied|exception/i.test(line));
  errors.slice(-3).forEach((line, idx) => add(`error-${idx}`, "Recent error", line, "error"));

  if (!normalized.length) {
    add("empty", "No logs yet", "Start a scan to stream activity here.", "muted");
  }

  return insights;
}

export function LogsPanel() {
  const [logFiles, setLogFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [logLines, setLogLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [lineSearch, setLineSearch] = useState("");
  const eventSourceRef = useRef(null);
  const seenLinesRef = useRef(new Set());
  const insights = useMemo(() => deriveInsights(logLines), [logLines]);

  useEffect(() => {
    let aborted = false;
    apiGet("/logs/list")
      .then((files) => {
        if (aborted) return;
        setLogFiles(files || []);
        if (files && files.length > 0) setSelectedFile(files[0]);
      })
      .catch(() => {
        if (!aborted) setLogFiles([]);
      });
    return () => { aborted = true; };
  }, []);

  useEffect(() => {
    if (!selectedFile) return;
    if (eventSourceRef.current) {
      try { eventSourceRef.current.close(); } catch {}
      eventSourceRef.current = null;
    }
    seenLinesRef.current = new Set();
    setLogLines([]);
    setLoading(true);
    const enc = encodeURIComponent(selectedFile);

    if (streaming) {
      const es = new EventSource(sseUrl(`/logs/${enc}/stream`));
      es.onmessage = (event) => {
        const line = (event.data ?? "").trim();
        if (!seenLinesRef.current.has(line)) {
          seenLinesRef.current.add(line);
          setLogLines((prev) => [...prev.slice(-500), line]);
        }
      };
      es.onerror = () => {
        try { es.close(); } catch {}
        eventSourceRef.current = null;
      };
      eventSourceRef.current = es;
      setLoading(false);
    } else {
      apiGet(`/logs/${enc}`)
        .then((data) => {
          const lines = (data?.content || "").split("\n");
          lines.forEach((line) => seenLinesRef.current.add(line));
          setLogLines(lines.slice(-500));
        })
        .catch(() => {
          setLogLines(["[ERROR] Failed to load log"]);
        })
        .finally(() => setLoading(false));
    }
    return () => {
      if (eventSourceRef.current) {
        try { eventSourceRef.current.close(); } catch {}
        eventSourceRef.current = null;
      }
    };
  }, [selectedFile, streaming]);

  const handleDownload = () => {
    if (!selectedFile) return;
    const enc = encodeURIComponent(selectedFile);
    const link = document.createElement("a");
    link.href = `${API_BASE_URL}/logs/${enc}/download`;
    link.download = selectedFile;
    link.click();
  };

  const highlightMatch = (line) => {
    if (!lineSearch) return line;
    const escaped = lineSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = line.split(new RegExp(`(${escaped})`, "gi"));
    return parts.map((part, i) =>
      part.toLowerCase() === lineSearch.toLowerCase() ? (
        <span key={i} className="bg-yellow-300 text-black px-1 rounded">{part}</span>
      ) : (
        <span key={i}>{part}</span>
      )
    );
  };

  const filteredLogLines = useMemo(() => {
    if (!lineSearch) return logLines;
    const lowerSearch = lineSearch.toLowerCase();
    return logLines.filter(l => l.toLowerCase().includes(lowerSearch));
  }, [logLines, lineSearch]);

  return (
    <div className="p-4 bg-gray-900 text-green-300 font-mono rounded shadow h-full w-full flex flex-col space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <LogFileDropdown
          files={logFiles}
          value={selectedFile}
          onChange={setSelectedFile}
        />
        <button
          onClick={handleDownload}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1 rounded shrink-0 disabled:opacity-50"
          disabled={!selectedFile}
          title="Download current log"
        >
          Download
        </button>
        <button
          onClick={() => setStreaming((prev) => !prev)}
          className={`px-4 py-1 rounded text-white shrink-0 ${
            streaming ? "bg-red-600 hover:bg-red-700" : "bg-gray-700 hover:bg-gray-600"
          }`}
          disabled={!selectedFile}
        >
          {streaming ? "Stop Live" : "Live Stream"}
        </button>
        <input
          type="text"
          placeholder="Search in log..."
          value={lineSearch}
          onChange={(e) => setLineSearch(e.target.value)}
          className="bg-gray-800 text-white px-2 py-1 rounded border border-gray-600 w-full sm:w-64 md:w-80 shrink-0"
        />
      </div>

      {insights.length > 0 && (
        <div className="bg-gray-800 border border-gray-700 rounded p-3 text-sm text-gray-200 space-y-2">
          <p className="text-xs uppercase tracking-wide text-gray-400">Agent activity</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {insights.map((insight, idx) => {
              const toneClass =
                insight.tone === "error"
                  ? "border-rose-400/50 bg-rose-500/10"
                  : insight.tone === "success"
                    ? "border-emerald-400/50 bg-emerald-500/10"
                    : insight.tone === "info"
                      ? "border-blue-400/50 bg-blue-500/10"
                      : "border-gray-500/50 bg-gray-800/60";
              return (
                <div
                  key={`${insight.label}-${idx}`}
                  className={`rounded border px-3 py-2 ${toneClass}`}
                >
                  <p className="font-semibold">{insight.label}</p>
                  <p className="text-xs text-gray-100 leading-relaxed">{insight.detail}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="overflow-auto bg-black p-4 border border-gray-700 rounded flex-1 min-h-0 whitespace-pre-wrap text-sm">
        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : filteredLogLines.length > 0 ? (
          filteredLogLines.map((line, idx) => <div key={idx}>{highlightMatch(line)}</div>)
        ) : (
          <p className="text-gray-400">No content</p>
        )}
      </div>
    </div>
  );
}