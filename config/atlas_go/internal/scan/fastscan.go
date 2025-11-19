package scan

import (
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"atlas/internal/utils"
)

// FastScanOptions controls how the fast scan behaves (local DB write vs remote payload).
type FastScanOptions struct {
	SkipDB bool
	Remote RemotePayloadOptions
}

// POINT 1: Get the default gateway IP (internal)
func getDefaultGateway() (string, error) {
	out, err := exec.Command("ip", "route").Output()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "default") {
			fields := strings.Fields(line)
			for i, f := range fields {
				if f == "via" && i+1 < len(fields) {
					return fields[i+1], nil
				}
			}
		}
	}
	return "", fmt.Errorf("no default gateway found")
}

func runNmap(subnet string) (map[string]string, error) {
	out, err := exec.Command("nmap", "-sn", subnet).Output()
	if err != nil {
		return nil, err
	}

	hosts := make(map[string]string)
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "Nmap scan report for") {
			fields := strings.Fields(line)
			if len(fields) == 6 && strings.HasPrefix(fields[5], "(") {
				name := fields[4]
				ip := strings.Trim(fields[5], "()")
				hosts[ip] = name
			} else if len(fields) == 5 {
				ip := fields[4]
				name := "NoName"
				hosts[ip] = name
			}
		}
	}
	return hosts, nil
}

func updateExternalIPInDB(dbPath string) {
	urls := []string{
		"https://ifconfig.me",
		"https://api.ipify.org",
	}

	var ip string
	for _, url := range urls {
		out, err := exec.Command("curl", "-s", url).Output()
		if err == nil && len(out) > 0 {
			ip = strings.TrimSpace(string(out))
			break
		}
	}

	if ip == "" {
		fmt.Println("⚠️ Could not determine external IP")
		return
	}

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		fmt.Println("❌ Failed to open DB:", err)
		return
	}
	defer db.Close()

	_, _ = db.Exec(`
        INSERT OR IGNORE INTO external_networks (public_ip)
        VALUES (?)
    `, ip)

	_, _ = db.Exec(`
        UPDATE external_networks
        SET last_seen = CURRENT_TIMESTAMP
        WHERE public_ip = ?
    `, ip)

	fmt.Println("🌐 External IP recorded:", ip)
}

func FastScan(opts FastScanOptions) error {
	logFile := "/config/logs/fast_scan_progress.log"
	lf, _ := os.Create(logFile)
	var (
		hosts []HostRecord
		err   error
	)
	start := time.Now()
	if lf != nil {
		defer lf.Close()
		fmt.Fprintf(lf, "🚀 Fast scan started at %s\n", start.Format(time.RFC3339))
		hosts, err = fastScanCore(lf)
		fmt.Fprintf(lf, "Fast scan complete in %s\n", time.Since(start))
	} else {
		hosts, err = fastScanCore(nil)
	}
	if err != nil {
		return err
	}

	if !opts.SkipDB {
		if err := SaveHostsToDB("/config/db/atlas.db", hosts); err != nil {
			return err
		}
		updateExternalIPInDB("/config/db/atlas.db")
	}

	if err := emitHosts(hosts, opts.Remote); err != nil {
		return err
	}

	return nil
}

func fastScanCore(lf *os.File) ([]HostRecord, error) {
	logf := func(format string, args ...any) {
		msg := fmt.Sprintf(format, args...)
		fmt.Println(msg)
		if lf != nil {
			fmt.Fprintln(lf, msg)
		}
	}

	interfaces, err := utils.GetAllInterfaces()
	if err != nil {
		return nil, fmt.Errorf("failed to detect network interfaces: %v", err)
	}

	gatewayIP, err := getDefaultGateway()
	if err != nil {
		logf("⚠️ Could not determine gateway: %v", err)
		gatewayIP = ""
	}

	var discovered []HostRecord
	for _, iface := range interfaces {
		logf("Discovering live hosts on %s (interface: %s)...", iface.Subnet, iface.Name)
		hosts, err := runNmap(iface.Subnet)
		if err != nil {
			logf("⚠️ Failed to scan subnet %s on interface %s: %v", iface.Subnet, iface.Name, err)
			continue
		}
		logf("Discovered %d hosts on %s", len(hosts), iface.Subnet)
		for ip, name := range hosts {
			record := HostRecord{
				IP:            ip,
				Hostname:      name,
				OS:            "Unknown",
				MAC:           "Unknown",
				PortSummary:   "Unknown",
				NextHop:       gatewayIP,
				NetworkName:   "LAN",
				InterfaceName: iface.Name,
				LastSeen:      time.Now(),
				OnlineStatus:  "online",
				Metadata: map[string]any{
					"scanner": "fastscan",
					"subnet":  iface.Subnet,
				},
			}
			if gatewayIP != "" {
				record.Metadata["gateway_ip"] = gatewayIP
			}
			discovered = append(discovered, record)
		}
	}

	logf("Total hosts discovered: %d", len(discovered))
	return discovered, nil
}
