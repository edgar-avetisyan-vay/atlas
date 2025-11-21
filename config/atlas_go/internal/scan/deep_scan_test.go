package scan

import "testing"

func TestParseNmapPortsIncludesOpenVariants(t *testing.T) {
	details := parseNmapPorts("53/open|filtered/tcp//domain///, 123/open/udp//ntp///, 161/filtered/udp//snmp///")
	if len(details.Ports) != 3 {
		t.Fatalf("expected 3 ports, got %d", len(details.Ports))
	}

	states := []string{details.Ports[0].State, details.Ports[1].State, details.Ports[2].State}
	expected := []string{"open|filtered", "open", "filtered"}
	for i, want := range expected {
		if states[i] != want {
			t.Errorf("port %d state mismatch: want %s got %s", i, want, states[i])
		}
	}
}

func TestParseNmapPortsIncludesUnfiltered(t *testing.T) {
	details := parseNmapPorts("80/unfiltered/tcp//http///, 443/closed/tcp//https///")
	if len(details.Ports) != 1 {
		t.Fatalf("expected 1 port, got %d", len(details.Ports))
	}
	if details.Ports[0].Port != 80 || details.Ports[0].State != "unfiltered" {
		t.Fatalf("unexpected port entry: %+v", details.Ports[0])
	}
}
