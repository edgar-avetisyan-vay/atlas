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
## 🚀 Quick Start (local build only, zero registry dependency)
Most contributors just want Atlas running locally without touching Docker Hub. Run the helper script that ships with this repo:

```bash
chmod +x local-run.sh
./local-run.sh
```

The script:
- writes `data/html/build-info.json` so the UI footer shows the build time,
- builds a throwaway `atlas-local` image with BuildKit,
- stops/replaces any existing `atlas-local` container, and
- starts Atlas on host networking with the UI at `http://localhost:8884/` and the FastAPI docs at `http://localhost:8884/api/docs`.

No registries, no pushes, no extra flags – rerun the script whenever you need a fresh copy.

Ports default to `ATLAS_UI_PORT=8884` (proxied API) and `ATLAS_API_PORT=8885`. Override them only if they clash with another local service:

```bash
ATLAS_UI_PORT=9000 ATLAS_API_PORT=9001 ./local-run.sh
```

If the browser only shows the stock NGINX welcome page, it usually means the container never started the FastAPI/React stack. Double-check that `local-run.sh` completed without errors and that no other service is already bound to the UI/API ports.

### Handy environment knobs for local testing

These are the only variables you typically touch while iterating:

```bash
FASTSCAN_INTERVAL=1800 \   # seconds between ARP sweeps
DOCKERSCAN_INTERVAL=1800 \ # docker socket inventory refresh
DEEPSCAN_INTERVAL=7200 \   # slower nmap-style passes
SCAN_SUBNETS="192.168.1.0/24,10.0.0.0/24" \ # override auto-detected CIDRs
  ./local-run.sh
```

Leave everything unset to let Atlas auto-detect local interfaces.

The container starts the scheduler automatically. Use the UI Scripts panel or the API to re-trigger scans whenever you like.

---
## ⚙️ Environment Variables
| Variable | Purpose | Default |
| --- | --- | --- |
| `ATLAS_UI_PORT` | Port NGINX listens on for the UI and proxied API | `8888` |
| `ATLAS_API_PORT` | Port the FastAPI app listens on internally | `8889` |
| `FASTSCAN_INTERVAL` | Seconds between fast ARP/host scans | `3600` |
| `DOCKERSCAN_INTERVAL` | Seconds between Docker inventory refreshes | `3600` |
| `DEEPSCAN_INTERVAL` | Seconds between deeper Nmap-style scans | `7200` |
| `SCAN_SUBNETS` | Optional comma-separated list of CIDRs to scan. Leave unset to auto-detect the local subnet. | _unset_ |

### Remote controller & agent settings

| Variable | Purpose | Default |
| --- | --- | --- |
| `ATLAS_CONTROLLER_URL` | Base URL for the central controller API (e.g. `https://atlas.example.com/api`) | _unset_ |
| `ATLAS_SITE_ID` | Site identifier used when posting to `/sites/{site}/agents/{agent}/ingest` | _unset_ |
| `ATLAS_SITE_NAME` | Optional friendly name shown in the controller UI | falls back to `ATLAS_SITE_ID` |
| `ATLAS_AGENT_ID` | Unique agent identifier within the site | _unset_ |
| `ATLAS_AGENT_VERSION` | Label included in ingest payloads (`atlas fastscan --agent-version v1.0.0`) | scanner build version |
| `ATLAS_AGENT_TOKEN` | Bearer token that is attached as `Authorization: Bearer <token>` when posting to the controller | _unset_ |
| `ATLAS_AGENT_INTERVAL` | Interval for `atlas agent` when running in container mode. Supports Go duration strings (`15m`, `1h`) or seconds. | `15m` |
| `ATLAS_AGENT_ONCE` | Set to `true`/`1` to run a single remote scan and exit | `false` |

---
## 🛠️ Building the image yourself
```bash
git clone https://github.com/<your-org>/atlas.git
cd atlas

# Build the multi-stage Docker image (UI assets are compiled inside the Dockerfile)
DOCKER_BUILDKIT=1 docker build -t atlas:dev .

# Optionally provide UI metadata for the build tag
DOCKER_BUILDKIT=1 docker build \
  --build-arg UI_VERSION="1.2.3" \
  --build-arg UI_COMMIT="$(git rev-parse --short HEAD)" \
  --build-arg UI_BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  -t atlas:dev .

# Run your freshly built image (same flags as the quick start)
docker run -d --name atlas --network host --cap-add NET_RAW --cap-add NET_ADMIN \
  -v /var/run/docker.sock:/var/run/docker.sock atlas:dev
```

`config/scripts/write_build_info.sh` is a small helper that writes `build-info.json` files (used by the UI footer). Run it locally to update `data/html/build-info.json` for development, or let the container entrypoint run it at boot to stamp the production assets automatically.

### 🔁 Offline-first helper script
If you prefer a single workflow that stays completely inside this repository (no Docker Hub access required), use [`deploy.sh`](./deploy.sh):
```bash
chmod +x deploy.sh
# Builds atlas-local:<timestamp>, runs it, and never tries to push anywhere
./deploy.sh
```
By default the script:

- Generates `data/html/build-info.json` locally so the UI footer has build metadata.
- Builds a Docker image tagged as `atlas-local:<timestamp>` (override with `--image` or `IMAGE=...`).
- Skips all network pushes so the image never leaves your workstation.
- Stops/replaces the `atlas-dev` container so junior teammates can simply rerun the script to refresh their test instance.

Power users can still opt-in to extra behaviour:

- `./deploy.sh --version mytag --tag-latest --push` to restore the former release-style flow.
- `./deploy.sh --skip-run` if you only want the image artefact.
- `RUN_BACKUP=1 BACKUP_SCRIPT=/path/to/script.sh ./deploy.sh` for pre-deploy backups.

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
- `/config/scripts/atlas_check.sh` – entrypoint (initialises DB, schedules scans, launches FastAPI + NGINX)
- `/config/nginx/default.conf.template` – rendered with the UI/API port env vars at runtime
- `/config/db/atlas.db` – SQLite database generated when the container starts

---
## 🌐 Remote sites, agents & subnet scans
Atlas can ingest data pushed from remote agents: `POST /api/sites/{site_id}/agents/{agent_id}/ingest`. The Sites tab in the UI stays empty until at least one site reports in, so use the workflow below to seed it.

### 1. Build the lightweight agent image

```bash
docker build -f Dockerfile.agent -t atlas-agent .
```

### 2. Launch the remote agent next to the network you want to monitor

```bash
docker run -d --name atlas-agent \
  --network host \
  --cap-add NET_RAW --cap-add NET_ADMIN \
  -e ATLAS_CONTROLLER_URL=https://controller.example.com/api \
  -e ATLAS_SITE_ID=branch-001 \
  -e ATLAS_SITE_NAME="Branch Office" \
  -e ATLAS_AGENT_ID=edge01 \
  -e ATLAS_AGENT_TOKEN=<api-token> \
  -e SCAN_SUBNETS="192.168.10.0/24" \
  atlas-agent
```

Important switches:
- `ATLAS_CONTROLLER_URL` – points at the public controller UI/API that receives ingests.
- `ATLAS_SITE_ID` / `ATLAS_SITE_NAME` – control how the site tile is labelled in the UI.
- `ATLAS_AGENT_ID` – identifies each remote probe so you can track heartbeats.
- `SCAN_SUBNETS` – comma-separated list of CIDRs to override auto-detection when the agent sits on a trunk port.
- `ATLAS_AGENT_INTERVAL` / `ATLAS_AGENT_ONCE` – adjust how frequently `atlas agent` posts results.

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
2. **Tail both sets of logs.** `docker logs -f atlas-agent` should show the scan followed by `Posting payload to …` (or an HTTP error). On the controller side run `docker logs -f atlas-local` and watch for `POST /api/sites/.../ingest` entries or FastAPI tracebacks. If the controller never logs the ingest route the request is not reaching it.
3. **Validate reachability from the agent host.** Run `curl -v http://10.1.255.110:8885/api/health` (swap the scheme/port for your deployment) from the same machine that hosts the agent container. Successful output proves routing, DNS, and certificates are correct.
4. **Check site/agent identifiers.** The controller discards payloads whose `{site_id, agent_id}` do not match an existing site/agent pair. Make sure the IDs in the agent env vars are exactly the ones you created via the UI/API (case sensitive, no extra whitespace).
5. **Authenticate if required.** If your controller enforces auth, export `ATLAS_AGENT_TOKEN` and verify the token issuer expects a `Bearer` header. 401/403 responses in the agent logs almost always point to a missing/invalid token.

Running the agent and controller on the same host is supported as long as the controller URL points back to the host network (usually `http://127.0.0.1:<api-port>/api` or the host’s LAN IP). Once the ingest succeeds the Sites tile updates immediately, and “Last Seen” matches the agent’s heartbeat interval.
- **UI doesn’t load on 8888?** Override `ATLAS_UI_PORT` (e.g. `-e ATLAS_UI_PORT=8884`) and make sure the host firewall allows the port you choose.
- **Empty response / no network data?** Give the container `--network host` plus both `NET_RAW` and `NET_ADMIN` capabilities so ARP and Docker scans work. Without them the backend has nothing to display.
- **Rebuild React UI** simply by running `docker build` – the `ui-builder` stage now runs `npm ci && npm run build` automatically.

---
## 📄 License
[MIT](./LICENSE)
