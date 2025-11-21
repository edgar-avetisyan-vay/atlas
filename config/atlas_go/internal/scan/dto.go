package scan

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ScannerVersion is embedded into remote payloads so the controller can
// report the agent build that produced the inventory. It can be overridden at
// build time using -ldflags "-X atlas/internal/scan.ScannerVersion=vX.Y.Z".
var ScannerVersion = "dev"

// RemotePort mirrors the FastAPI RemotePort model.
type RemotePort struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Service  string `json:"service,omitempty"`
	State    string `json:"state,omitempty"`
}

// RemoteHostPayload matches the /ingest payload contract.
type RemoteHostPayload struct {
	IP       string         `json:"ip"`
	Hostname string         `json:"hostname,omitempty"`
	OS       string         `json:"os,omitempty"`
	MAC      string         `json:"mac,omitempty"`
	Note     string         `json:"note,omitempty"`
	Tags     []string       `json:"tags,omitempty"`
	LastSeen string         `json:"last_seen,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
	Ports    []RemotePort   `json:"ports,omitempty"`
}

// RemotePayload is the top-level request body for /ingest.
type RemotePayload struct {
	SiteName     string              `json:"site_name,omitempty"`
	AgentVersion string              `json:"agent_version,omitempty"`
	Hosts        []RemoteHostPayload `json:"hosts"`
}

// HostRecord is the canonical representation of a discovered host within the
// scanner. Every scan mode converts its findings into HostRecords so they can
// be written to SQLite or emitted as remote payloads consistently.
type HostRecord struct {
	IP            string
	Hostname      string
	OS            string
	MAC           string
	PortSummary   string
	Ports         []RemotePort
	NextHop       string
	NetworkName   string
	InterfaceName string
	Tags          []string
	Note          string
	Metadata      map[string]any
	LastSeen      time.Time
	OnlineStatus  string
}

// PortDetails bundles the slice of remote ports with the string summary we
// store in SQLite for backwards compatibility.
type PortDetails struct {
	Summary string
	Ports   []RemotePort
}

func (h HostRecord) metadataForPayload() map[string]any {
	meta := map[string]any{}
	if h.Metadata != nil {
		for k, v := range h.Metadata {
			meta[k] = v
		}
	}
	if h.InterfaceName != "" {
		meta["interface_name"] = h.InterfaceName
	}
	if h.NetworkName != "" {
		meta["network_name"] = h.NetworkName
	}
	if h.NextHop != "" {
		meta["next_hop"] = h.NextHop
	}
	return meta
}

// PortsSummary returns the textual representation stored in SQLite.
func (h HostRecord) PortsSummary() string {
	if h.PortSummary != "" {
		return h.PortSummary
	}
	if len(h.Ports) == 0 {
		return "Unknown"
	}
	var readable []string
	for _, p := range h.Ports {
		part := fmt.Sprintf("%d/%s", p.Port, p.Protocol)
		if p.Service != "" {
			part = fmt.Sprintf("%s (%s)", part, p.Service)
		}
		if p.State != "" {
			part = fmt.Sprintf("%s [%s]", part, p.State)
		}
		readable = append(readable, part)
	}
	if len(readable) == 0 {
		return "Unknown"
	}
	return strings.Join(readable, ", ")
}

// ToRemoteHostPayload converts the HostRecord into the JSON-friendly shape the
// FastAPI controller expects.
func (h HostRecord) ToRemoteHostPayload() RemoteHostPayload {
	lastSeen := ""
	if !h.LastSeen.IsZero() {
		lastSeen = h.LastSeen.UTC().Format(time.RFC3339)
	}
	payload := RemoteHostPayload{
		IP:       h.IP,
		Hostname: h.Hostname,
		OS:       h.OS,
		MAC:      h.MAC,
		Note:     h.Note,
		Tags:     h.Tags,
		LastSeen: lastSeen,
		Metadata: nil,
		Ports:    h.Ports,
	}
	meta := h.metadataForPayload()
	if len(meta) > 0 {
		payload.Metadata = meta
	}
	if len(payload.Tags) == 0 {
		payload.Tags = nil
	}
	if len(payload.Ports) == 0 {
		payload.Ports = nil
	}
	return payload
}

// BuildRemotePayload wraps host payloads with site metadata.
func BuildRemotePayload(siteName, agentVersion string, hosts []HostRecord) RemotePayload {
	payload := RemotePayload{
		SiteName:     siteName,
		AgentVersion: agentVersion,
	}
	payload.Hosts = make([]RemoteHostPayload, 0, len(hosts))
	for _, host := range hosts {
		payload.Hosts = append(payload.Hosts, host.ToRemoteHostPayload())
	}
	return payload
}

// EmitRemotePayload marshals the payload into JSON (for stdout) and/or posts it
// to the configured controller endpoint.
type RemotePayloadOptions struct {
	PrintJSON bool
	Config    RemoteConfig
}

func (o RemotePayloadOptions) shouldEmit() bool {
	return o.PrintJSON || o.Config.Enabled()
}

func (o RemotePayloadOptions) emit(payload RemotePayload) error {
	if !o.shouldEmit() {
		return nil
	}
	if o.PrintJSON {
		b, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(b))
	}
	if o.Config.Enabled() {
		return o.Config.PostPayload(payload)
	}
	return nil
}

func emitHosts(hosts []HostRecord, opts RemotePayloadOptions) error {
	if !opts.shouldEmit() {
		return nil
	}
	if len(hosts) == 0 {
		fmt.Println("⚠️ No hosts discovered; skipping remote payload")
		return nil
	}
	var withoutPorts, withPorts int
	for _, h := range hosts {
		if len(h.Ports) == 0 {
			withoutPorts++
		} else {
			withPorts++
		}
	}
	fmt.Printf("[remote] preparing payload for %d hosts (%d with ports, %d without)\n", len(hosts), withPorts, withoutPorts)
	if withoutPorts > 0 {
		for _, h := range hosts {
			if len(h.Ports) == 0 {
				fmt.Printf("[remote] host %s has no parsed ports; summary=%q interface=%s\n", h.IP, h.PortSummary, h.InterfaceName)
			}
		}
	}
	siteName := opts.Config.SiteName
	if siteName == "" {
		siteName = opts.Config.SiteID
	}
	agentVersion := opts.Config.AgentVersion
	if agentVersion == "" {
		agentVersion = ScannerVersion
	}
	payload := BuildRemotePayload(siteName, agentVersion, hosts)
	return opts.emit(payload)
}

// SaveHostsToDB persists the provided records into the local SQLite database.
func SaveHostsToDB(dbPath string, hosts []HostRecord) error {
	if len(hosts) == 0 {
		return nil
	}
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	interfaces := map[string]struct{}{}
	for _, host := range hosts {
		if host.InterfaceName != "" {
			interfaces[host.InterfaceName] = struct{}{}
		}
	}
	for name := range interfaces {
		_, _ = db.Exec("UPDATE hosts SET online_status = 'offline' WHERE interface_name = ?", name)
	}

	for _, host := range hosts {
		if err := upsertHost(db, host); err != nil {
			return err
		}
	}
	return nil
}

func upsertHost(db *sql.DB, host HostRecord) error {
	if host.NetworkName == "" {
		host.NetworkName = "LAN"
	}
	if host.LastSeen.IsZero() {
		host.LastSeen = time.Now()
	}
	if host.OnlineStatus == "" {
		host.OnlineStatus = "online"
	}
	openPorts := host.PortsSummary()
	_, err := db.Exec(`
        INSERT INTO hosts (
            ip, name, os_details, mac_address, open_ports, next_hop,
            network_name, interface_name, last_seen, online_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ip, interface_name) DO UPDATE SET
            name=excluded.name,
            os_details=excluded.os_details,
            mac_address=excluded.mac_address,
            open_ports=excluded.open_ports,
            next_hop=excluded.next_hop,
            last_seen=excluded.last_seen,
            online_status=excluded.online_status
    `, host.IP, host.Hostname, host.OS, host.MAC, openPorts, host.NextHop,
		host.NetworkName, host.InterfaceName, host.LastSeen.Format("2006-01-02 15:04:05"), host.OnlineStatus)
	return err
}
