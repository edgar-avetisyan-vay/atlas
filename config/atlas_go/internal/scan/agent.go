package scan

import (
	"errors"
	"fmt"
	"time"
)

// AgentConfig drives the remote agent loop.
type AgentConfig struct {
	Remote      RemoteConfig
	Interval    time.Duration
	Once        bool
	PrintJSON   bool
	ScanCommand string
}

// RunRemoteAgent executes the requested scan on a schedule and ships the
// payload to the controller.
func RunRemoteAgent(cfg AgentConfig) error {
	if !cfg.Remote.Enabled() {
		return errors.New("remote agent requires controller URL, site ID, and agent ID")
	}
	if cfg.Remote.SiteName == "" {
		cfg.Remote.SiteName = cfg.Remote.SiteID
	}
	if cfg.Remote.AgentVersion == "" {
		cfg.Remote.AgentVersion = ScannerVersion
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 15 * time.Minute
	}
	if cfg.ScanCommand == "" {
		cfg.ScanCommand = "deepscan"
	}

	remoteOpts := RemotePayloadOptions{PrintJSON: cfg.PrintJSON, Config: cfg.Remote}

	runID := fmt.Sprintf("agent-%d", time.Now().UnixNano())
	fmt.Printf("[agent] run-id=%s controller=%s site=%s agent=%s interval=%s once=%v scan=%s\n",
		runID, cfg.Remote.ControllerURL, cfg.Remote.SiteID, cfg.Remote.AgentID, cfg.Interval, cfg.Once, cfg.ScanCommand)
	if cfg.PrintJSON {
		fmt.Println("[agent] JSON output enabled; payloads will be written to stdout")
	}

	runOnce := func() error {
		switch cfg.ScanCommand {
		case "fastscan":
			return FastScan(FastScanOptions{
				SkipDB: true,
				Remote: remoteOpts,
			})
		case "deepscan":
			return DeepScan(DeepScanOptions{
				SkipDB: true,
				Remote: remoteOpts,
			})
		default:
			return fmt.Errorf("remote agent does not support %s", cfg.ScanCommand)
		}
	}

	start := time.Now()
	if err := runOnce(); err != nil {
		fmt.Printf("[agent] initial %s failed after %s: %v\n", cfg.ScanCommand, time.Since(start), err)
		return err
	}
	fmt.Printf("[agent] initial %s completed in %s\n", cfg.ScanCommand, time.Since(start))
	if cfg.Once {
		return nil
	}

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	iteration := 1
	for tick := range ticker.C {
		iteration++
		start := time.Now()
		fmt.Printf("[agent] run %d starting at %s\n", iteration, tick.Format(time.RFC3339))
		if err := runOnce(); err != nil {
			fmt.Printf("[agent] run %d failed after %s: %v\n", iteration, time.Since(start), err)
			continue
		}
		fmt.Printf("[agent] run %d finished in %s\n", iteration, time.Since(start))
	}
	return nil
}
