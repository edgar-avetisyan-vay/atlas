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
The **bare-minimum command** pulls the public image and runs it with the permissions the scanner needs. No tagging, no pushes, no extra knobs:

```bash
docker pull atlasproject/atlas:latest
docker run -d \
  --name atlas \
  --network host \
  --cap-add NET_RAW \
  --cap-add NET_ADMIN \
  -v /var/run/docker.sock:/var/run/docker.sock \
  atlasproject/atlas:latest
```

Ports default to `ATLAS_UI_PORT=8888` and `ATLAS_API_PORT=8889`, so hit `http://localhost:8888/` for the UI and `http://localhost:8888/api/docs` for the FastAPI docs. Override the ports only if you really need to:

```bash
docker run -d \
  --name atlas \
  --network host \
  --cap-add NET_RAW \
  --cap-add NET_ADMIN \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e ATLAS_UI_PORT=8884 \
  -e ATLAS_API_PORT=8885 \
  atlasproject/atlas:latest
```

**Optional knobs** (leave them alone unless you need to tweak scheduling):

```bash
-e FASTSCAN_INTERVAL=3600 \
-e DOCKERSCAN_INTERVAL=3600 \
-e DEEPSCAN_INTERVAL=7200 \
-e SCAN_SUBNETS="192.168.1.0/24,10.0.0.0/24" \
```

**Access**
- UI: `http://<host-ip>:ATLAS_UI_PORT` (defaults to `http://localhost:8888/` – change it to `8884` or anything else if you prefer)
- API: `http://<host-ip>:ATLAS_UI_PORT/api/docs` via the UI proxy (or `http://<host-ip>:ATLAS_API_PORT/api/docs` directly)

If the browser only shows the stock NGINX welcome page, it usually means the container never started the FastAPI/React stack. Double-check that you used `--network host` and both capability flags – without them the entrypoint exits early.

---
## 🙋 One-command local build (no pushes, no tags)
Need an even simpler flow for teammates that just want it running on their laptop? Use the new helper script:

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
