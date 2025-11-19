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
## 🚀 Quick Start (pull & run)
```bash
# 1. Pull the latest published image
docker pull atlasproject/atlas:latest

# 2. Run it (requires host networking + NET_RAW/NET_ADMIN so the scanner can talk to the LAN)
docker run -d \
  --name atlas \
  --network host \
  --cap-add NET_RAW \
  --cap-add NET_ADMIN \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e ATLAS_UI_PORT=8884 \
  -e ATLAS_API_PORT=8885 \
  -e FASTSCAN_INTERVAL=3600 \
  -e DOCKERSCAN_INTERVAL=3600 \
  -e DEEPSCAN_INTERVAL=7200 \
  -e SCAN_SUBNETS="192.168.1.0/24,10.0.0.0/24" \
  atlasproject/atlas:latest
```
**Access**
- UI: `http://<host-ip>:ATLAS_UI_PORT` (default 8888 – set it yourself if you prefer e.g. `8884`)
- API: `http://<host-ip>:ATLAS_API_PORT/api/docs` (FastAPI docs are also reachable through the UI proxy: `http://<host-ip>:ATLAS_UI_PORT/api/docs`)

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

### 🔁 End-to-end helper script
If you prefer a single guided workflow that writes `data/html/build-info.json`, builds/tags/pushes the Docker image, and runs the container, use [`deploy.sh`](./deploy.sh):
```bash
chmod +x deploy.sh
# Defaults to atlasproject/atlas; override with --image or IMAGE=my-registry/atlas
./deploy.sh
```
The script prompts for the version tag, whether to tag as `latest`, and whether to push to Docker Hub. It also cleans up any old `atlas-dev` container before starting the new one. Optional hooks:

- Override the container registry by passing `--image ghcr.io/my-org/atlas` (or exporting `IMAGE=...`).
- Run a custom backup command by exporting `RUN_BACKUP=1 BACKUP_SCRIPT=/path/to/script.sh`.

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
## 🌐 Remote sites & ingestion
Atlas can ingest data pushed from remote agents: `POST /api/sites/{site_id}/agents/{agent_id}/ingest` with a payload that lists hosts and metadata. The React UI includes a **Sites** tab and the API exposes helper endpoints (`/api/sites/summary`, `/api/sites/{site_id}/hosts`, `/api/sites/{site_id}/agents`) so you can monitor every location from a single controller.

### CLI helpers

```bash
# Discover hosts and print the ingest payload without touching SQLite
./atlas fastscan --json

# Discover hosts and POST directly to a controller
./atlas fastscan \
  --remote https://controller.example.com/api \
  --site branch-001 \
  --agent edge01 \
  --token <api-token> \
  --site-name "Branch Office" \
  --agent-version v0.3.0
```

The same `--remote/--site/--agent/--token/--json` flags exist for `dockerscan`. When either `--remote` or `--json` is specified the scanner produces the `/ingest` DTOs instead of writing to SQLite, so you can script remote pushes or pipe the JSON elsewhere.

### Remote agent container

[`Dockerfile.agent`](./Dockerfile.agent) builds a slim image that only contains the Go scanner. It boots into `atlas agent`, honours the controller env vars listed above, and posts results on a schedule:

```bash
docker build -f Dockerfile.agent -t atlas-agent .
docker run -d --name atlas-agent \
  --network host \
  --cap-add NET_RAW --cap-add NET_ADMIN \
  -e ATLAS_CONTROLLER_URL=https://controller.example.com/api \
  -e ATLAS_SITE_ID=branch-001 \
  -e ATLAS_AGENT_ID=edge01 \
  -e ATLAS_AGENT_TOKEN=<api-token> \
  atlas-agent
```

Set `ATLAS_AGENT_INTERVAL` (supports values like `10m`, `3600`) or `ATLAS_AGENT_ONCE=true` to control scheduling behaviour. Logs stream to stdout so `docker logs atlas-agent` shows every ingest attempt.

---
## 🧪 Troubleshooting tips
- **UI doesn’t load on 8888?** Override `ATLAS_UI_PORT` (e.g. `-e ATLAS_UI_PORT=8884`) and make sure the host firewall allows the port you choose.
- **Empty response / no network data?** Give the container `--network host` plus both `NET_RAW` and `NET_ADMIN` capabilities so ARP and Docker scans work. Without them the backend has nothing to display.
- **Rebuild React UI** simply by running `docker build` – the `ui-builder` stage now runs `npm ci && npm run build` automatically.

---
## 📄 License
[MIT](./LICENSE)
