package scan

import (
	"bufio"
	"database/sql"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"atlas/internal/utils"
	_ "github.com/mattn/go-sqlite3"
)

// Use - for all ports (TCP/UDP)
const tcpPortArg = "-"

// const udpPortArg = "-" // UDP scan commented

type HostInfo struct {
	IP            string
	Name          string
	InterfaceName string
}

// DeepScanOptions controls how deep scans persist and emit data.
type DeepScanOptions struct {
	SkipDB bool
	Remote RemotePayloadOptions
}

// Try NetBIOS (nbtscan) for hostname resolution
func getNetBIOSName(ip string) string {
	out, err := exec.Command("nbtscan", ip).Output()
	if err != nil {
		return ""
	}
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		fields := strings.Fields(line)
		// nbtscan output format: IP Name <other info>
		if len(fields) >= 2 && fields[0] == ip {
			return fields[1]
		}
	}
	return ""
}

// Returns best available host name using nmap, reverse DNS, NetBIOS
func bestHostName(ip string, nmapName string) string {
	if nmapName != "" && nmapName != "NoName" {
		return nmapName
	}
	name := getHostName(ip)
	if name != "" && name != "NoName" {
		return name
	}
	name = getNetBIOSName(ip)
	if name != "" {
		return name
	}
	return "NoName"
}

func discoverLiveHosts(subnet string) ([]HostInfo, error) {
	out, err := exec.Command("nmap", "-sn", subnet).Output()
	if err != nil {
		return nil, err
	}
	var hosts []HostInfo
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "Nmap scan report for") {
			fields := strings.Fields(line)
			if len(fields) == 6 && strings.HasPrefix(fields[5], "(") {
				name := fields[4]
				ip := strings.Trim(fields[5], "()")
				hosts = append(hosts, HostInfo{IP: ip, Name: name})
			} else if len(fields) == 5 {
				ip := fields[4]
				hosts = append(hosts, HostInfo{IP: ip, Name: "NoName"})
			}
		}
	}
	return hosts, nil
}

// Parse nmap port string to human-readable form (show only open/filtered)
func parseNmapPorts(s string) PortDetails {
	parts := strings.Split(s, ",")
	var readable []string
	var ports []RemotePort
	for _, p := range parts {
		fields := strings.Split(p, "/")
		if len(fields) < 5 {
			continue
		}
		state := fields[1]
		proto := fields[2]
		service := fields[4]
		portStr := fields[0]
		if state == "open" || state == "filtered" {
			part := fmt.Sprintf("%s/%s", portStr, proto)
			if service != "" {
				part = fmt.Sprintf("%s (%s)", part, service)
			}
			readable = append(readable, part)
			portNum, _ := strconv.Atoi(portStr)
			ports = append(ports, RemotePort{Port: portNum, Protocol: proto, Service: service, State: state})
		}
	}
	summary := "Unknown"
	if len(readable) > 0 {
		summary = strings.Join(readable, ", ")
	}
	return PortDetails{Summary: summary, Ports: ports}
}

func scanAllTcp(ip string, logProgress io.Writer) (PortDetails, string) {
	logFile := fmt.Sprintf("/config/logs/nmap_tcp_%s.log", strings.ReplaceAll(ip, ".", "_"))
	// Force host up status with -Pn so port scans proceed even when ICMP is filtered.
	nmapArgs := []string{"-O", "-Pn", "-p-", ip, "-oG", logFile}
	start := time.Now()
	cmd := exec.Command("nmap", nmapArgs...)
	cmd.Stdout = logProgress
	cmd.Stderr = logProgress
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(logProgress, "[nmap] command failed for %s: %v\n", ip, err)
		return PortDetails{Summary: "Unknown"}, "Unknown"
	}
	elapsed := time.Since(start)
	fmt.Fprintf(logProgress, "TCP scan for %s finished in %s\n", ip, elapsed)

	file, err := os.Open(logFile)
	if err != nil {
		return PortDetails{Summary: "Unknown"}, "Unknown"
	}
	defer file.Close()

	ports := PortDetails{Summary: "Unknown"}
	var osInfo string
	// Match all text between Ports: and Ignored State:
	rePorts := regexp.MustCompile(`Ports: ([^\n]*?)Ignored State:`)
	reOS := regexp.MustCompile(`OS: (.*)`)

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if m := rePorts.FindStringSubmatch(line); m != nil {
			ports = parseNmapPorts(m[1])
		}
		if m := reOS.FindStringSubmatch(line); m != nil {
			rawOs := m[1]
			osInfo = strings.SplitN(rawOs, "\t", 2)[0]
			if idx := strings.Index(osInfo, "Seq Index:"); idx != -1 {
				osInfo = strings.TrimSpace(osInfo[:idx])
			}
			osInfo = strings.TrimSpace(osInfo)
		}
	}
	if len(ports.Ports) == 0 {
		fmt.Fprintf(logProgress, "[nmap] no open or filtered ports parsed for %s; check %s for raw output\n", ip, logFile)
	}
	return ports, osInfo
}

// func scanAllUdp(ip string, logProgress *os.File) string {
// 	nmapArgs := []string{"-sU", "-p-", ip, "-oG", "/config/logs/nmap_udp.log"}
// 	start := time.Now()
// 	cmd := exec.Command("nmap", nmapArgs...)
// 	cmd.Run()
// 	elapsed := time.Since(start)
// 	fmt.Fprintf(logProgress, "UDP scan for %s finished in %s\n", ip, elapsed)

// 	file, err := os.Open("/config/logs/nmap_udp.log")
// 	if err != nil {
// 		return "Unknown"
// 	}
// 	defer file.Close()

// 	var ports string
// 	rePorts := regexp.MustCompile(`Ports: ([^ ]+)`)

// 	scanner := bufio.NewScanner(file)
// 	for scanner.Scan() {
// 		line := scanner.Text()
// 		if m := rePorts.FindStringSubmatch(line); m != nil {
// 			ports = parseNmapPorts(m[1])
// 		}
// 	}
// 	return ports
// }

func getHostName(ip string) string {
	names, err := net.LookupAddr(ip)
	if err != nil || len(names) == 0 {
		return "NoName"
	}
	return strings.TrimSuffix(names[0], ".")
}

func getMacAddress(ip string) string {
	file, err := os.Open("/proc/net/arp")
	if err != nil {
		return "Unknown"
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Scan() // Skip header
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 4 && fields[0] == ip {
			return fields[3]
		}
	}
	return "Unknown"
}

func DeepScan(opts DeepScanOptions) error {
	// Get all network interfaces
	interfaces, err := utils.GetAllInterfaces()
	if err != nil {
		fmt.Printf("⚠️ Could not auto-detect interfaces: %v, using fallback\n", err)
		// Fallback to default subnet if auto-detection fails
		interfaces = []utils.InterfaceInfo{{Name: "unknown", Subnet: "192.168.2.0/24", IP: ""}}
	}

	startTime := time.Now()
	logFile := "/config/logs/deep_scan_progress.log"
	lf, _ := os.Create(logFile)
	defer lf.Close()
	logProgress := io.MultiWriter(lf, os.Stdout)

	var hostInfos []HostInfo

	// Discover live hosts on all interfaces
	for _, iface := range interfaces {
		fmt.Fprintf(logProgress, "Discovering live hosts on %s (interface: %s)...\n", iface.Subnet, iface.Name)
		hosts, err := discoverLiveHosts(iface.Subnet)
		if err != nil {
			fmt.Fprintf(logProgress, "Failed to discover hosts on %s: %v\n", iface.Subnet, err)
			continue
		}
		fmt.Fprintf(logProgress, "Discovered %d hosts on %s\n", len(hosts), iface.Subnet)
		// Add interface name to each host
		for _, host := range hosts {
			host.InterfaceName = iface.Name
			hostInfos = append(hostInfos, host)
		}
	}

	total := len(hostInfos)
	fmt.Fprintf(logProgress, "Total discovered: %d hosts in %s\n", total, time.Since(startTime))

	var db *sql.DB
	if !opts.SkipDB {
		dbPath := "/config/db/atlas.db"
		db, err = sql.Open("sqlite3", dbPath)
		if err != nil {
			fmt.Fprintf(logProgress, "Failed to open DB: %v\n", err)
			return err
		}
		defer db.Close()

		// Mark all hosts as offline before scanning
		if _, err := db.Exec("UPDATE hosts SET online_status = 'offline'"); err != nil {
			fmt.Fprintf(logProgress, "Failed to mark hosts as offline: %v\n", err)
		}
	}

	var wg sync.WaitGroup
	var remoteBatch []HostRecord
	var batchMu sync.Mutex
	for idx, host := range hostInfos {
		wg.Add(1)
		go func(idx int, host HostInfo) {
			defer wg.Done()
			hostStart := time.Now()
			ip := host.IP
			// Use bestHostName for all fallback methods
			name := bestHostName(ip, host.Name)
			fmt.Fprintf(logProgress, "Scanning host %d/%d: %s\n", idx+1, total, ip)

			tcpPorts, osInfo := scanAllTcp(ip, logProgress)
			mac := getMacAddress(ip)
			status := utils.PingHost(ip)
			elapsed := time.Since(startTime)
			hostsLeft := total - (idx + 1)
			estLeft := time.Duration(0)
			if idx+1 > 0 {
				estLeft = (elapsed / time.Duration(idx+1)) * time.Duration(hostsLeft)
			}
			fmt.Fprintf(logProgress, "Host %s: TCP ports: %s, OS: %s\n", ip, tcpPorts.Summary, osInfo)
			fmt.Fprintf(logProgress, "Progress: %d/%d hosts, elapsed: %s, estimated left: %s\n", idx+1, total, elapsed, estLeft)

			record := HostRecord{
				IP:            ip,
				Hostname:      name,
				OS:            osInfo,
				MAC:           mac,
				PortSummary:   tcpPorts.Summary,
				Ports:         tcpPorts.Ports,
				InterfaceName: host.InterfaceName,
				NetworkName:   "LAN",
				LastSeen:      time.Now(),
				OnlineStatus:  status,
				Metadata: map[string]any{
					"scanner": "deepscan",
				},
			}
			if db != nil {
				if err := upsertHost(db, record); err != nil {
					fmt.Fprintf(logProgress, "❌ Update failed for %s on interface %s: %v\n", ip, host.InterfaceName, err)
				}
			}
			batchMu.Lock()
			remoteBatch = append(remoteBatch, record)
			batchMu.Unlock()
			fmt.Fprintf(logProgress, "Host %s scanned in %s\n", ip, time.Since(hostStart))
		}(idx, host)
	}
	wg.Wait()

	fmt.Fprintf(logProgress, "Deep scan complete in %s\n", time.Since(startTime))
	if err := emitHosts(remoteBatch, opts.Remote); err != nil {
		return err
	}
	return nil
}
