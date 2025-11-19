# 🌐 Atlas - Network Infrastructure Visualizer

Atlas is a containerized stack (Go scanner + FastAPI API + NGINX + React UI) that discovers the hosts that live on or near the Docker host it runs on and renders the results in an interactive dashboard. Everything you need to build, run, or redeploy the tool is in this repository.

---
## ✨ Highlights
- **Docker & host scanners** collect IPs, MACs, open ports, network names, and per-interface metadata for containers and LAN devices.
- **FastAPI backend** exposes the collected data (`/api/*`) and accepts pushes from remote agents.
- **React UI** (served through NGINX) visualizes the inventory and lets you trigger scans or adjust schedules.
- **Single container deployment** – build once, run anywhere with a couple of environment variables.

---
## 🚀 Quick Start (build locally & run)
1. **Clone this repo and enter it**
   ```bash
   git clone https://github.com/<your-org>/atlas.git
   cd atlas
   ```
2. **Use the helper script to build the UI, assemble the Docker image, and run it on your machine.** The script only uses the files in this repo – nothing is pulled from Docker Hub unless _you_ opt into pushing at the end.
   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```
   Respond to the prompts (pick any version label you like, answer “n” when asked about tagging `latest` or pushing) and the script will:
   - install/build the React UI,
   - sync `data/react-ui/dist` into `data/html`,
   - build a Docker image from the local Dockerfile, and
   - start a container named `atlas-dev` with host networking + the required capabilities.

**Prefer to run the container manually?** After cloning, follow the manual build steps below to create a local image (for example `atlas:local`) and then run it yourself:
```bash
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
  atlas:local
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

---
## 🛠️ Building the image yourself
```bash
git clone https://github.com/<your-org>/atlas.git
cd atlas

# Build the React UI (once per change)
cd data/react-ui
npm install     # or npm ci when package-lock.json is present
npm run build
cd ../..

# Sync the built UI into data/html (what the Dockerfile copies into the image)
rm -rf data/html/*
cp -r data/react-ui/dist/* data/html/

# Build the multi-stage Docker image
DOCKER_BUILDKIT=1 docker build -t atlas:dev .

# Run your freshly built image (same flags as the quick start)
docker run -d --name atlas --network host --cap-add NET_RAW --cap-add NET_ADMIN \
  -v /var/run/docker.sock:/var/run/docker.sock atlas:dev
```

### 🔁 End-to-end helper script
If you prefer a single guided workflow that builds the UI, writes `data/html/build-info.json`, builds/tags/pushes the Docker image, and runs the container, use [`deploy.sh`](./deploy.sh):
```bash
chmod +x deploy.sh
./deploy.sh
```
The script prompts for the version tag, whether to tag as `latest`, and whether to push to Docker Hub. It also cleans up any old `atlas-dev` container before starting the new one.

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

---
## 🧪 Troubleshooting tips
- **UI doesn’t load on 8888?** Override `ATLAS_UI_PORT` (e.g. `-e ATLAS_UI_PORT=8884`) and make sure the host firewall allows the port you choose.
- **Empty response / no network data?** Give the container `--network host` plus both `NET_RAW` and `NET_ADMIN` capabilities so ARP and Docker scans work. Without them the backend has nothing to display.
- **Rebuild React UI** whenever you change `data/react-ui`. Copy the `dist/` output into `data/html/` _before_ building the Docker image or running `deploy.sh`.

---
## 📄 License
[MIT](./LICENSE)
