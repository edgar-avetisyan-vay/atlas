# 🌐 Atlas - Network Infrastructure Visualizer

Atlas is a containerized stack (Go scanner + FastAPI API + NGINX + React UI) that discovers the hosts that live on or near the Docker host it runs on and renders the results in an interactive dashboard. Everything you need to build, run, or redeploy the tool is in this repository.

### 📢 Migration notice

This project is now maintained by the community instead of the original author. Images are published to the `atlasproject/atlas` namespace going forward. If you have older notes or scripts that reference `keinstien/atlas`, update them to the new registry so future contributors and reviewers are all working from the same commands.

---
## ✨ Highlights
- **Docker & host scanners** collect IPs, MACs, open ports, network names, and per-interface metadata for containers and LAN devices.
- **FastAPI backend** exposes the collected data (`/api/*`) and accepts pushes from remote agents.
- **React UI** (served through NGINX) visualizes the inventory and lets you trigger scans or adjust schedules.
- **Single container deployment** – build once, run anywhere with a couple of environment variables.

---
## 🚀 Quick Start (script-driven only)
Atlas now ships with a single script that handles both server and agent deployments. No manual `docker build`, `docker run`, or "power user" flow is required (or documented) anymore.

```bash
chmod +x local-run.sh
```

### Server mode (controller only)
Run the controller/UI without performing any local scans. This is the default mode.

```bash
./local-run.sh server
```

The script writes `data/html/build-info.json`, builds a throwaway `atlas-local` image, replaces any `atlas-local` container, and launches the stack on host networking. Because the server stays in "listener" mode, it never touches the host network interfaces nor the Docker socket—remote agents feed it data instead. The UI lives at `http://localhost:8884/` (override with `ATLAS_UI_PORT`/`ATLAS_API_PORT`).

### Agent mode (deep scan + report)
Remote agents are just as simple: export the controller details and run the same script in `agent` mode.

```bash
export ATLAS_CONTROLLER_URL="http://controller.example.com:8885/api"
export ATLAS_SITE_ID="branch-001"
export ATLAS_AGENT_ID="edge01"
export ATLAS_AGENT_TOKEN="<api-token>"
# Optional extras
export ATLAS_SITE_NAME="Branch 001"
export SCAN_SUBNETS="192.168.10.0/24"

./local-run.sh agent
```

The helper builds the lightweight agent image (`Dockerfile.agent`), runs it with the required capabilities, and schedules recurring deep scans that immediately post their results to the controller. Agents never ship a UI or API—only the Go scanner binary plus its reporting loop.

---
## ⚙️ Environment Variables
| Variable | Purpose | Default |
| --- | --- | --- |
| `ATLAS_UI_PORT` | Port NGINX listens on for the UI and proxied API | `8888` |
| `ATLAS_API_PORT` | Port the FastAPI app listens on internally | `8889` |
| `ATLAS_MODE` | `server` (UI/API only) or `agent` (headless deep scan). Set automatically by `local-run.sh`. | `server` |
| `ATLAS_ENABLE_SCHEDULER` | Set to `1` to opt back into legacy on-box scans when running the server container manually. | `0` |
| `FASTSCAN_INTERVAL` | Seconds between fast ARP/host scans | `3600` |
| `DOCKERSCAN_INTERVAL` | Seconds between Docker inventory refreshes | `3600` |
| `DEEPSCAN_INTERVAL` | Seconds between deeper Nmap-style scans | `7200` |
| `SCAN_SUBNETS` | Optional comma-separated list of CIDRs to scan. Leave unset to auto-detect the local subnet. | _unset_ |

> Scheduler-related knobs only matter if you run the server container with `ATLAS_ENABLE_SCHEDULER=1`. The default server mode keeps scanning disabled so only remote agents touch your networks.

### Remote controller & agent settings

| Variable | Purpose | Default |
| --- | --- | --- |
| `ATLAS_CONTROLLER_URL` | Base URL for the central controller API (e.g. `https://atlas.example.com/api`) | _unset_ |
| `ATLAS_SITE_ID` | Site identifier used when posting to `/sites/{site}/agents/{agent}/ingest` | _unset_ |
| `ATLAS_SITE_NAME` | Optional friendly name shown in the controller UI | falls back to `ATLAS_SITE_ID` |
| `ATLAS_AGENT_ID` | Unique agent identifier within the site | _unset_ |
| `ATLAS_AGENT_VERSION` | Label included in ingest payloads (auto-populated from the scanner build version) | scanner build version |
| `ATLAS_AGENT_TOKEN` | Bearer token that is attached as `Authorization: Bearer <token>` when posting to the controller | _unset_ |
| `ATLAS_AGENT_INTERVAL` | Interval between deep scans when the agent loop runs. Supports Go duration strings (`15m`, `1h`) or seconds. | `15m` |
| `ATLAS_AGENT_ONCE` | Set to `true`/`1` to run a single remote scan and exit | `false` |

Use the **Sites** tab in the UI to pre-create locations and mint long-lived agent tokens. Each generated token is displayed for copy/paste so you can drop it straight into `ATLAS_AGENT_TOKEN` when launching the remote container.

---
## 🧱 Architecture overview
```
atlas/
├── config/
│   ├── atlas_go/        # Go CLI scanner source
│   ├── nginx/           # default.conf template (rewrites /api to FastAPI)
│   └── scripts/         # FastAPI app, scheduler, entrypoint shell scripts
├── data/
│   ├── html/            # Static assets copied into the container image
│   └── react-ui/        # React frontend source (Vite)
├── Dockerfile           # Builds Go binary + Python/FastAPI/NGINX runtime
├── deploy.sh            # Helper script for release builds & local runs
└── README.md
```

Inside the container everything lives under `/config`:
- `/config/bin/atlas` – Go scanner
- `/config/scripts/atlas_check.sh` – entrypoint (initialises DB and launches FastAPI + NGINX; scheduling is opt-in)
- `/config/nginx/default.conf.template` – rendered with the UI/API port env vars at runtime
- `/config/db/atlas.db` – SQLite database generated when the container starts

---
## 🌐 Remote sites, agents & subnet scans
Atlas can ingest data pushed from remote agents: `POST /api/sites/{site_id}/agents/{agent_id}/ingest`. The Sites tab in the UI stays empty until at least one site reports in, so use the workflow below to seed it.

### Launch the lightweight agent with `local-run.sh`

1. Export the controller/env variables (see the quick start section above).
2. Run `./local-run.sh agent` from this repository.
3. Tail `docker logs -f atlas-agent-local` (or your custom container name) to monitor deepscan progress and ingest responses.

Important switches:
- `ATLAS_CONTROLLER_URL` – points at the public controller UI/API that receives ingests.
- `ATLAS_SITE_ID` / `ATLAS_SITE_NAME` – control how the site tile is labelled in the UI.
- `ATLAS_AGENT_ID` – identifies each remote probe so you can track heartbeats.
- `SCAN_SUBNETS` – comma-separated list of CIDRs to override auto-detection when the agent sits on a trunk port.
- `ATLAS_AGENT_INTERVAL` / `ATLAS_AGENT_ONCE` – adjust how frequently the deep scan loop reports back.

Agents always perform full deep scans and immediately post their findings to the controller—no UI, scheduler, or local database is shipped in the agent container.

### 3. Dry-run scans or pipe JSON for automation

The Go binary (`config/atlas_go`) works outside of containers as well:

```bash
# Run a single fast scan and print the ingest payload to stdout
./atlas fastscan --json --site lab --agent laptop01 --site-name "R&D Lab"

# Post directly to a controller without touching SQLite
./atlas fastscan \
  --remote https://controller.example.com/api \
  --site lab \
  --agent laptop01 \
  --token <api-token> \
  --scan-subnets "10.10.0.0/24,10.10.1.0/24"
```

Use the same flags with `./atlas dockerscan` if you want remote Docker inventory instead of LAN discovery.

Once an agent ingests data the Sites panel shows the site name, total hosts, the last ingest time, and a per-agent heartbeat so you immediately know whether a probe is stale.

---
## 🧪 Troubleshooting tips

### Remote agent is scanning but the site stays empty
It usually means the agent completed the local scan but never managed to post the ingest payload to the controller. Walk through the steps below to pinpoint the break:

1. **Confirm the controller URL is valid.** The agent blindly POSTs to `ATLAS_CONTROLLER_URL`, so the value must be a real base API URL such as `http://10.1.255.110:8885/api`. Double check that you are not mixing schemes (`https://http://…`) or leaving out the controller’s port.
2. **Tail both sets of logs.** `docker logs -f atlas-agent-local` (or your agent container name) should show the scan followed by `Posting payload to …` (or an HTTP error). On the controller side run `docker logs -f atlas-local` and watch for `POST /api/sites/.../ingest` entries or FastAPI tracebacks. If the controller never logs the ingest route the request is not reaching it.
3. **Validate reachability from the agent host.** Run `curl -v http://10.1.255.110:8885/api/health` (swap the scheme/port for your deployment) from the same machine that hosts the agent container. Successful output proves routing, DNS, and certificates are correct.
4. **Check site/agent identifiers.** The controller discards payloads whose `{site_id, agent_id}` do not match an existing site/agent pair. Make sure the IDs in the agent env vars are exactly the ones you created via the UI/API (case sensitive, no extra whitespace).
5. **Authenticate if required.** If your controller enforces auth, export `ATLAS_AGENT_TOKEN` and verify the token issuer expects a `Bearer` header. 401/403 responses in the agent logs almost always point to a missing/invalid token.

Running the agent and controller on the same host is supported as long as the controller URL points back to the host network (usually `http://127.0.0.1:<api-port>/api` or the host’s LAN IP). Once the ingest succeeds the Sites tile updates immediately, and “Last Seen” matches the agent’s heartbeat interval.
- **UI doesn’t load on 8888?** Override `ATLAS_UI_PORT` (e.g. `-e ATLAS_UI_PORT=8884`) and make sure the host firewall allows the port you choose.
- **Empty response / no network data?** Agents must run with `--network host` plus both `NET_RAW` and `NET_ADMIN` so their deep scans can reach the LAN. `./local-run.sh agent` already sets these flags; copy them if you customize the runtime.
- **Need a fresh React UI build?** Rerun `./local-run.sh server`. The Dockerfile rebuilds the React assets automatically on every invocation.

---
## 📄 License
[MIT](./LICENSE)
