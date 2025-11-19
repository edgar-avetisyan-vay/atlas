from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import sqlite3
import subprocess
import logging
import os
import json
from datetime import datetime
from typing import Any, Dict, List, Optional
from scripts.scheduler import get_scheduler

app = FastAPI(
    title="Atlas Network API",
    description="Scan automation, infrastructure discovery, and visualization backend for Atlas",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    root_path="/api",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models for request/response
class IntervalUpdate(BaseModel):
    interval: int


class RemotePort(BaseModel):
    port: int
    protocol: str = "tcp"
    service: Optional[str] = None
    state: Optional[str] = None


class RemoteHost(BaseModel):
    ip: str
    hostname: Optional[str] = None
    os: Optional[str] = None
    mac: Optional[str] = None
    note: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    last_seen: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    ports: List[RemotePort] = Field(default_factory=list)


class RemoteIngestPayload(BaseModel):
    site_name: Optional[str] = None
    agent_version: Optional[str] = None
    hosts: List[RemoteHost]


class SiteDefinition(BaseModel):
    site_id: str = Field(..., min_length=1)
    site_name: Optional[str] = None
    description: Optional[str] = None

# Initialize scheduler on startup
scheduler = get_scheduler()

@app.on_event("startup")
async def startup_event():
    """Start the scheduler when the API starts."""
    logging.info("Starting scan scheduler...")
    scheduler.start()

LOGS_DIR = "/config/logs"
DB_PATH = "/config/db/atlas.db"
os.makedirs(LOGS_DIR, exist_ok=True)

REMOTE_HOSTS_TABLE = """
CREATE TABLE IF NOT EXISTS remote_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    site_name TEXT,
    agent_version TEXT,
    ip TEXT NOT NULL,
    hostname TEXT,
    os TEXT,
    mac TEXT,
    note TEXT,
    tags TEXT,
    ports_json TEXT,
    last_seen TEXT,
    metadata_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(site_id, agent_id, ip)
);
"""

REMOTE_AGENTS_TABLE = """
CREATE TABLE IF NOT EXISTS remote_agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    site_name TEXT,
    agent_version TEXT,
    last_ingest TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL,
    UNIQUE(site_id, agent_id)
);
"""

REMOTE_SITES_TABLE = """
CREATE TABLE IF NOT EXISTS remote_sites (
    site_id TEXT PRIMARY KEY,
    site_name TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_remote_tables(conn: sqlite3.Connection):
    conn.execute(REMOTE_HOSTS_TABLE)
    conn.execute(REMOTE_AGENTS_TABLE)
    conn.execute(REMOTE_SITES_TABLE)
    conn.commit()

# Scripts and their log files (used for POST tee + stream)
ALLOWED_SCRIPTS = {
    "scan-hosts-fast": {
        "cmd": "/config/bin/atlas fastscan",
        "log": os.path.join(LOGS_DIR, "scan-hosts-fast.log"),
    },
    "scan-hosts-deep": {
        "cmd": "/config/bin/atlas deepscan",
        "log": os.path.join(LOGS_DIR, "scan-hosts-deep.log"),
    },
    "scan-docker": {
        "cmd": "/config/bin/atlas dockerscan",
        "log": os.path.join(LOGS_DIR, "scan-docker.log"),
    },
}

@app.get("/health", tags=["Meta"])
def health():
    # Basic DB sanity: ensure hosts table exists
    db_ok = True
    try:
        conn = sqlite3.connect("/config/db/atlas.db")
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='hosts'")
        exists = cur.fetchone() is not None
        conn.close()
        if not exists:
            db_ok = False
    except Exception:
        db_ok = False

    return {
        "status": "ok",
        "db": "ok" if db_ok else "init_pending",
        "version": "1.0.0",
    }

@app.get("/hosts", tags=["Hosts"])
def get_hosts():
    conn = sqlite3.connect("/config/db/atlas.db")
    cursor1 = conn.cursor()
    cursor2 = conn.cursor()
    cursor1.execute("SELECT * FROM hosts")
    cursor2.execute("SELECT * FROM docker_hosts")
    rows1 = cursor1.fetchall()
    rows2 = cursor2.fetchall()
    conn.close()
    return [rows1, rows2]

@app.get("/external", tags=["Hosts"])
def get_external_networks():
    try:
        conn = sqlite3.connect("/config/db/atlas.db")
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM external_networks ORDER BY last_seen DESC LIMIT 1")
        row = cursor.fetchone()
        conn.close()
        return row if row else {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _serialize_remote_host(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "site_id": row["site_id"],
        "agent_id": row["agent_id"],
        "site_name": row["site_name"],
        "agent_version": row["agent_version"],
        "ip": row["ip"],
        "hostname": row["hostname"],
        "os": row["os"],
        "mac": row["mac"],
        "note": row["note"],
        "tags": json.loads(row["tags"]) if row["tags"] else [],
        "ports": json.loads(row["ports_json"]) if row["ports_json"] else [],
        "last_seen": row["last_seen"],
        "metadata": json.loads(row["metadata_json"]) if row["metadata_json"] else {},
        "updated_at": row["updated_at"],
    }


@app.post("/sites/{site_id}/agents/{agent_id}/ingest", tags=["Remote Sites"])
def ingest_remote_hosts(site_id: str, agent_id: str, payload: RemoteIngestPayload):
    if not payload.hosts:
        raise HTTPException(status_code=400, detail="hosts payload cannot be empty")

    now = datetime.utcnow().isoformat() + "Z"
    conn = get_db_connection()
    ensure_remote_tables(conn)
    cur = conn.cursor()

    # Ensure the site registry has a placeholder for this site so it shows up even before hosts ingest
    cur.execute(
        """
        INSERT INTO remote_sites(site_id, site_name, created_at, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET
            site_name=COALESCE(site_name, excluded.site_name),
            updated_at=excluded.updated_at
        """,
        (
            site_id,
            payload.site_name or site_id,
            now,
            now,
        ),
    )

    cur.execute(
        """
        INSERT INTO remote_agents(site_id, agent_id, site_name, agent_version, last_ingest, last_heartbeat)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_id, agent_id) DO UPDATE SET
            site_name=excluded.site_name,
            agent_version=excluded.agent_version,
            last_ingest=excluded.last_ingest,
            last_heartbeat=excluded.last_heartbeat
        """,
        (
            site_id,
            agent_id,
            payload.site_name,
            payload.agent_version,
            now,
            now,
        ),
    )

    inserted = 0
    for host in payload.hosts:
        tags_json = json.dumps(host.tags or []) if host.tags else json.dumps([])
        ports_json = json.dumps([port.dict() for port in host.ports]) if host.ports else json.dumps([])
        metadata_json = json.dumps(host.metadata or {}) if host.metadata else json.dumps({})
        last_seen = host.last_seen or now

        cur.execute(
            """
            INSERT INTO remote_hosts (
                site_id, agent_id, site_name, agent_version, ip, hostname,
                os, mac, note, tags, ports_json, last_seen, metadata_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(site_id, agent_id, ip) DO UPDATE SET
                hostname=excluded.hostname,
                os=excluded.os,
                mac=excluded.mac,
                note=excluded.note,
                tags=excluded.tags,
                ports_json=excluded.ports_json,
                last_seen=excluded.last_seen,
                metadata_json=excluded.metadata_json,
                updated_at=excluded.updated_at,
                site_name=excluded.site_name,
                agent_version=excluded.agent_version
            """,
            (
                site_id,
                agent_id,
                payload.site_name,
                payload.agent_version,
                host.ip,
                host.hostname,
                host.os,
                host.mac,
                host.note,
                tags_json,
                ports_json,
                last_seen,
                metadata_json,
                now,
            ),
        )
        inserted += 1

    conn.commit()
    conn.close()

    return {"status": "ok", "hosts_processed": inserted, "agent_id": agent_id, "site_id": site_id}


@app.post("/sites", tags=["Remote Sites"])
def register_site(site: SiteDefinition):
    site_id = site.site_id.strip()
    if not site_id:
        raise HTTPException(status_code=400, detail="site_id is required")

    site_name = site.site_name.strip() if site.site_name else site_id
    description = site.description.strip() if site.description else None
    now = datetime.utcnow().isoformat() + "Z"

    conn = get_db_connection()
    ensure_remote_tables(conn)
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO remote_sites(site_id, site_name, description, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET
            site_name=excluded.site_name,
            description=excluded.description,
            updated_at=excluded.updated_at
        """,
        (site_id, site_name, description, now, now),
    )
    conn.commit()
    conn.close()

    return {
        "status": "ok",
        "site_id": site_id,
        "site_name": site_name,
        "description": description,
        "updated_at": now,
    }


@app.get("/sites/summary", tags=["Remote Sites"])
def get_site_summary():
    conn = get_db_connection()
    ensure_remote_tables(conn)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            site_id,
            COALESCE(MAX(site_name), site_id) AS site_name,
            COUNT(DISTINCT ip) AS host_count,
            MAX(last_seen) AS last_seen,
            MAX(updated_at) AS updated_at
        FROM remote_hosts
        GROUP BY site_id
        ORDER BY site_id
        """
    )
    host_map = {
        row["site_id"]: {
            "site_name": row["site_name"],
            "host_count": row["host_count"],
            "last_seen": row["last_seen"],
            "updated_at": row["updated_at"],
        }
        for row in cur.fetchall()
    }

    cur.execute(
        """
        SELECT
            site_id,
            COALESCE(MAX(site_name), site_id) AS site_name,
            COUNT(*) as agent_count,
            MAX(last_heartbeat) as last_heartbeat
        FROM remote_agents
        GROUP BY site_id
        """
    )
    agent_map = {
        row["site_id"]: {
            "site_name": row["site_name"],
            "agent_count": row["agent_count"],
            "last_heartbeat": row["last_heartbeat"],
        }
        for row in cur.fetchall()
    }

    cur.execute(
        "SELECT site_id, site_name, description, created_at, updated_at FROM remote_sites"
    )
    site_registry = {
        row["site_id"]: {
            "site_name": row["site_name"],
            "description": row["description"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in cur.fetchall()
    }
    conn.close()

    summary = []
    all_site_ids = set(site_registry.keys()) | set(host_map.keys()) | set(agent_map.keys())

    for site_id in sorted(all_site_ids):
        registry = site_registry.get(site_id, {})
        host_stats = host_map.get(site_id, {})
        agent_info = agent_map.get(site_id, {})
        summary.append(
            {
                "site_id": site_id,
                "site_name": registry.get("site_name")
                or host_stats.get("site_name")
                or agent_info.get("site_name")
                or site_id,
                "description": registry.get("description"),
                "host_count": host_stats.get("host_count", 0),
                "last_seen": host_stats.get("last_seen") or agent_info.get("last_heartbeat"),
                "updated_at": host_stats.get("updated_at")
                or agent_info.get("last_heartbeat")
                or registry.get("updated_at"),
                "agent_count": agent_info.get("agent_count", 0),
                "last_heartbeat": agent_info.get("last_heartbeat"),
                "created_at": registry.get("created_at"),
            }
        )

    return summary


@app.get("/sites/{site_id}/hosts", tags=["Remote Sites"])
def get_hosts_for_site(site_id: str):
    conn = get_db_connection()
    ensure_remote_tables(conn)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT * FROM remote_hosts
        WHERE site_id = ?
        ORDER BY hostname IS NULL, hostname, ip
        """,
        (site_id,),
    )
    rows = cur.fetchall()
    conn.close()
    return [_serialize_remote_host(row) for row in rows]


@app.get("/sites/{site_id}/agents", tags=["Remote Sites"])
def get_agents_for_site(site_id: str):
    conn = get_db_connection()
    ensure_remote_tables(conn)
    cur = conn.cursor()
    cur.execute(
        "SELECT agent_id, site_name, agent_version, last_ingest, last_heartbeat FROM remote_agents WHERE site_id = ?",
        (site_id,),
    )
    rows = [
        {
            "agent_id": row[0],
            "site_name": row[1],
            "agent_version": row[2],
            "last_ingest": row[3],
            "last_heartbeat": row[4],
        }
        for row in cur.fetchall()
    ]
    conn.close()
    return rows

# POST still supported; now tees output to a persistent log file too
@app.post("/scripts/run/{script_name}", tags=["Scripts"])
def run_named_script(script_name: str):
    if script_name not in ALLOWED_SCRIPTS:
        raise HTTPException(status_code=400, detail="Invalid script name")

    cmd = ALLOWED_SCRIPTS[script_name]["cmd"]
    log_file = ALLOWED_SCRIPTS[script_name]["log"]
    os.makedirs(LOGS_DIR, exist_ok=True)
    open(log_file, "a").close()  # ensure exists

    try:
        shell_cmd = f'{cmd} 2>&1 | tee -a "{log_file}"'
        logging.debug(f"Running (tee to log): {shell_cmd}")
        result = subprocess.run(["bash", "-lc", shell_cmd], capture_output=True, text=True, check=True)
        return JSONResponse(content={"status": "success", "output": result.stdout})
    except subprocess.CalledProcessError as e:
        # also persist error output
        try:
            with open(log_file, "a") as f:
                if e.stdout: f.write(e.stdout)
                if e.stderr: f.write(e.stderr)
        except Exception:
            pass
        return JSONResponse(status_code=500, content={"status": "error", "output": e.stderr})

# NEW: proper live stream endpoint that ends when the process exits
@app.get("/scripts/run/{script_name}/stream", tags=["Scripts"])
def stream_named_script(script_name: str):
    if script_name not in ALLOWED_SCRIPTS:
        raise HTTPException(status_code=400, detail="Invalid script name")

    cmd = ALLOWED_SCRIPTS[script_name]["cmd"]
    log_file = ALLOWED_SCRIPTS[script_name]["log"]
    os.makedirs(LOGS_DIR, exist_ok=True)
    open(log_file, "a").close()

    def event_generator():
        # Use bash -lc so pipes/aliases work if needed
        process = subprocess.Popen(
            ["bash", "-lc", cmd],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        try:
            with open(log_file, "a", buffering=1) as lf:
                for line in iter(process.stdout.readline, ''):
                    lf.write(line)
                    yield f"data: {line.rstrip()}\n\n"
            rc = process.wait()
            # Let the client know we are done; then the HTTP connection is closed
            yield f"data: [exit {rc}]\n\n"
        except GeneratorExit:
            # Client closed connection; stop the process
            try: process.kill()
            except Exception: pass
        except Exception as e:
            yield f"data: [ERROR] {str(e)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/scripts/last-scan-status", tags=["Scripts"])
def last_scan_status():
    conn = sqlite3.connect("/config/db/atlas.db")
    cur = conn.cursor()

    def get_latest(table):
        cur.execute(f"SELECT MAX(last_seen) FROM {table}")
        result = cur.fetchone()
        return result[0] if result and result[0] else None

    return {
        "fast": get_latest("hosts"),
        "deep": get_latest("hosts"),
        "docker": get_latest("docker_hosts")
    }

@app.get("/logs/list", tags=["Logs"])
def list_logs():
    files = []
    for name in os.listdir(LOGS_DIR):
        if not name.endswith(".log"):
            continue
        # Hide verbose per-host nmap logs from the UI list
        if name.startswith("nmap_tcp_") or name.startswith("nmap_udp_"):
            continue
        files.append(name)
    try:
        containers = subprocess.check_output(["docker", "ps", "--format", "{{.Names}}"], text=True).splitlines()
        files += [f"container:{c}" for c in containers]
    except Exception:
        pass
    return files

@app.get("/logs/{filename}", tags=["Logs"])
def read_log(filename: str):
    if filename.startswith("container:"):
        container = filename.split("container:")[1]
        try:
            result = subprocess.run(["docker", "logs", "--tail", "500", container], capture_output=True, text=True)
            return {"content": result.stdout}
        except Exception as e:
            return {"content": f"[ERROR] Failed to get logs for container '{container}': {str(e)}"}

    filepath = f"{LOGS_DIR}/{filename}"
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="File not found")

    with open(filepath, "r") as f:
        return {"content": f.read()}

@app.get("/logs/{filename}/download", tags=["Logs"])
def download_log(filename: str):
    if filename.startswith("container:"):
        container = filename.split("container:")[1]
        try:
            logs = subprocess.check_output(["docker", "logs", container], text=True)
            return Response(
                content=logs,
                media_type="text/plain",
                headers={"Content-Disposition": f"attachment; filename={container}.log"}
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to get container logs: {str(e)}")

    filepath = f"{LOGS_DIR}/{filename}"
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(filepath, filename=filename)

@app.get("/containers", tags=["Docker"])
def list_containers():
    try:
        output = subprocess.check_output(["docker", "ps", "--format", "{{.Names}}"], text=True)
        return output.strip().split("\n")
    except Exception:
        return []

@app.get("/logs/container/{container_name}", tags=["Docker"])
def get_container_logs(container_name: str):
    try:
        result = subprocess.run(["docker", "logs", "--tail", "1000", container_name], capture_output=True, text=True, check=True)
        return {"logs": result.stdout}
    except subprocess.CalledProcessError as e:
        return {"logs": f"[ERROR] Failed to get logs: {e.stderr}"}

@app.get("/logs/{filename}/stream", tags=["Logs"])
def stream_log(filename: str):
    def event_generator():
        if filename.startswith("container:"):
            container = filename.split("container:")[1]
            cmd = ["docker", "logs", "-f", "--tail", "10", container]
        else:
            filepath = f"{LOGS_DIR}/{filename}"
            if not os.path.exists(filepath):
                yield f"data: [ERROR] File not found: {filepath}\n\n"
                return
            # NOTE: -F follows forever; the client must close this
            cmd = ["tail", "-n", "10", "-F", filepath]

        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            for line in process.stdout:
                yield f"data: {line.rstrip()}\n\n"
        except GeneratorExit:
            process.kill()
        except Exception as e:
            yield f"data: [ERROR] {str(e)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/scheduler/intervals", tags=["Scheduler"])
def get_scheduler_intervals():
    """Get current scan intervals for all scan types."""
    return scheduler.get_intervals()

@app.put("/scheduler/intervals/{scan_type}", tags=["Scheduler"])
def update_scheduler_interval(scan_type: str, data: IntervalUpdate):
    """Update the interval for a specific scan type."""
    try:
        scheduler.update_interval(scan_type, data.interval)
        return {"status": "success", "scan_type": scan_type, "interval": data.interval}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/scheduler/status", tags=["Scheduler"])
def get_scheduler_status():
    """Get scheduler status."""
    return {
        "running": scheduler.is_running(),
        "intervals": scheduler.get_intervals()
    }