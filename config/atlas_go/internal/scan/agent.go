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
		cfg.ScanCommand = "fastscan"
	}

	runOnce := func() error {
		switch cfg.ScanCommand {
		case "fastscan":
			return FastScan(FastScanOptions{
				SkipDB: true,
				Remote: RemotePayloadOptions{
					PrintJSON: cfg.PrintJSON,
					Config:    cfg.Remote,
				},
			})
		default:
			return fmt.Errorf("remote agent does not support %s", cfg.ScanCommand)
		}
	}

	if err := runOnce(); err != nil {
		return err
	}
	if cfg.Once {
		return nil
	}

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	for range ticker.C {
		if err := runOnce(); err != nil {
			fmt.Printf("agent run failed: %v\n", err)
		}
	}
	return nil
}
