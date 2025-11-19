package scan

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strings"
	"time"
)

// RemoteConfig stores connection details for the controller ingest endpoint.
type RemoteConfig struct {
	ControllerURL string
	SiteID        string
	AgentID       string
	SiteName      string
	AgentVersion  string
	Token         string
	HTTPClient    *http.Client
}

// Enabled returns true when all mandatory fields are set.
func (rc RemoteConfig) Enabled() bool {
	return rc.ControllerURL != "" && rc.SiteID != "" && rc.AgentID != ""
}

func (rc RemoteConfig) endpoint() (string, error) {
	if !rc.Enabled() {
		return "", errors.New("remote config incomplete: controller url, site id, and agent id are required")
	}
	base := strings.TrimRight(rc.ControllerURL, "/")
	ingestPath := path.Join("sites", rc.SiteID, "agents", rc.AgentID, "ingest")
	return fmt.Sprintf("%s/%s", base, ingestPath), nil
}

// PostPayload sends the payload to the controller.
func (rc RemoteConfig) PostPayload(payload RemotePayload) error {
	endpoint, err := rc.endpoint()
	if err != nil {
		return err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	client := rc.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if rc.Token != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", rc.Token))
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("remote ingest failed: %s", resp.Status)
	}
	return nil
}
