package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"atlas/internal/db"
	"atlas/internal/scan"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]
	switch cmd {
	case "fastscan":
		fmt.Println("🚀 Running fast scan...")
		opts, err := parseFastScanOptions(args)
		if err != nil {
			log.Fatalf("❌ Fast scan flag error: %v", err)
		}
		if err := scan.FastScan(opts); err != nil {
			log.Fatalf("❌ Fast scan failed: %v", err)
		}
		fmt.Println("✅ Fast scan complete.")
	case "dockerscan":
		fmt.Println("🐳 Running Docker scan...")
		opts, err := parseDockerScanOptions(args)
		if err != nil {
			log.Fatalf("❌ Docker scan flag error: %v", err)
		}
		if err := scan.DockerScan(opts); err != nil {
			log.Fatalf("❌ Docker scan failed: %v", err)
		}
		fmt.Println("✅ Docker scan complete.")
	case "deepscan":
		fmt.Println("🚀 Running deep scan...")
		if err := scan.DeepScan(scan.DeepScanOptions{}); err != nil {
			log.Fatalf("❌ Deep scan failed: %v", err)
		}
		fmt.Println("✅ Deep scan complete.")
	case "initdb":
		fmt.Println("📦 Initializing database...")
		if err := db.InitDB(); err != nil {
			log.Fatalf("❌ DB init failed: %v", err)
		}
		fmt.Println("✅ Database initialized.")
	case "agent":
		fmt.Println("🤖 Starting remote agent...")
		cfg, err := parseAgentConfig(args)
		if err != nil {
			log.Fatalf("❌ Agent flag error: %v", err)
		}
		if err := scan.RunRemoteAgent(cfg); err != nil {
			log.Fatalf("❌ Agent failed: %v", err)
		}
	default:
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("Usage: atlas <command> [flags]")
	fmt.Println("Commands: fastscan, dockerscan, deepscan, initdb, agent")
}

func parseFastScanOptions(args []string) (scan.FastScanOptions, error) {
	fs := flag.NewFlagSet("fastscan", flag.ExitOnError)
	skipDB := fs.Bool("skip-db", false, "skip writing hosts to SQLite (implied when --remote or --json is set)")
	remoteFlags := bindRemoteFlags(fs)
	if err := fs.Parse(args); err != nil {
		return scan.FastScanOptions{}, err
	}
	remoteOpts, err := remoteFlags.options()
	if err != nil {
		return scan.FastScanOptions{}, err
	}
	skip := *skipDB
	if !skip && (remoteOpts.PrintJSON || remoteOpts.Config.Enabled()) {
		skip = true
	}
	return scan.FastScanOptions{SkipDB: skip, Remote: remoteOpts}, nil
}

func parseDockerScanOptions(args []string) (scan.DockerScanOptions, error) {
	fs := flag.NewFlagSet("dockerscan", flag.ExitOnError)
	remoteFlags := bindRemoteFlags(fs)
	if err := fs.Parse(args); err != nil {
		return scan.DockerScanOptions{}, err
	}
	remoteOpts, err := remoteFlags.options()
	if err != nil {
		return scan.DockerScanOptions{}, err
	}
	return scan.DockerScanOptions{Remote: remoteOpts}, nil
}

func parseAgentConfig(args []string) (scan.AgentConfig, error) {
	fs := flag.NewFlagSet("agent", flag.ExitOnError)
	remoteFlags := bindRemoteFlags(fs)
	interval := fs.Duration("interval", envDuration("ATLAS_AGENT_INTERVAL", 15*time.Minute), "interval between scans (e.g. 15m or seconds)")
	once := fs.Bool("once", envBool("ATLAS_AGENT_ONCE", false), "run a single scan and exit")
	if err := fs.Parse(args); err != nil {
		return scan.AgentConfig{}, err
	}
	remoteOpts, err := remoteFlags.options()
	if err != nil {
		return scan.AgentConfig{}, err
	}
	return scan.AgentConfig{
		Remote:      remoteOpts.Config,
		Interval:    *interval,
		Once:        *once,
		PrintJSON:   remoteOpts.PrintJSON,
		ScanCommand: "deepscan",
	}, nil
}

type remoteFlagConfig struct {
	remoteURL  *string
	siteID     *string
	siteName   *string
	agentID    *string
	agentName  *string
	agentToken *string
	printJSON  *bool
}

func bindRemoteFlags(fs *flag.FlagSet) remoteFlagConfig {
	return remoteFlagConfig{
		remoteURL:  fs.String("remote", os.Getenv("ATLAS_CONTROLLER_URL"), "controller base URL (e.g. https://host/api)"),
		siteID:     fs.String("site", os.Getenv("ATLAS_SITE_ID"), "site identifier"),
		siteName:   fs.String("site-name", os.Getenv("ATLAS_SITE_NAME"), "site display name"),
		agentID:    fs.String("agent", os.Getenv("ATLAS_AGENT_ID"), "agent identifier"),
		agentName:  fs.String("agent-version", getenvDefault("ATLAS_AGENT_VERSION", scan.ScannerVersion), "agent version label"),
		agentToken: fs.String("token", os.Getenv("ATLAS_AGENT_TOKEN"), "API token for Authorization header"),
		printJSON:  fs.Bool("json", false, "print the ingest payload to stdout"),
	}
}

func (r remoteFlagConfig) options() (scan.RemotePayloadOptions, error) {
	cfg := scan.RemoteConfig{
		ControllerURL: *r.remoteURL,
		SiteID:        *r.siteID,
		SiteName:      *r.siteName,
		AgentID:       *r.agentID,
		AgentVersion:  *r.agentName,
		Token:         *r.agentToken,
	}
	if cfg.AgentVersion == "" {
		cfg.AgentVersion = scan.ScannerVersion
	}
	opts := scan.RemotePayloadOptions{PrintJSON: *r.printJSON, Config: cfg}
	if cfg.ControllerURL != "" && (cfg.SiteID == "" || cfg.AgentID == "") {
		return opts, fmt.Errorf("--site and --agent are required when --remote is specified")
	}
	return opts, nil
}

func getenvDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if dur, err := time.ParseDuration(v); err == nil {
			return dur
		}
		if secs, err := strconv.Atoi(v); err == nil {
			return time.Duration(secs) * time.Second
		}
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		vl := strings.ToLower(v)
		return vl == "1" || vl == "true" || vl == "yes"
	}
	return fallback
}
