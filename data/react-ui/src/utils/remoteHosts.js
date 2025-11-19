function describePorts(ports = []) {
  if (!Array.isArray(ports) || !ports.length) return "no_ports";
  return ports
    .map((port) => {
      if (!port || typeof port !== "object") return "";
      const proto = port.protocol || "tcp";
      const label = port.service ? ` (${port.service})` : "";
      return `${port.port}/${proto}${label}`;
    })
    .filter(Boolean)
    .join(", ");
}

function metadataValue(metadata, ...keys) {
  if (!metadata) return undefined;
  for (const key of keys) {
    if (metadata[key] !== undefined && metadata[key] !== null) {
      return metadata[key];
    }
  }
  return undefined;
}

export function remoteHostToRow(host, idx = 0) {
  const metadata = host?.metadata || {};
  const id = host?.id || `${host?.site_id || "remote"}-${host?.agent_id || "agent"}-${idx}`;
  const ports = describePorts(host?.ports);
  const nextHop = metadataValue(metadata, "next_hop", "gateway", "router") || "Unknown";
  const network = metadataValue(metadata, "network", "network_name", "subnet", "vlan") || host?.site_name || "";
  const interfaceName = metadataValue(metadata, "interface_name", "interface", "iface") || "remote";
  const onlineStatus = metadataValue(metadata, "online_status", "state", "status") || "online";
  const lastSeen = host?.last_seen || host?.updated_at || "";

  return [
    id,
    host?.ip || "",
    host?.hostname || host?.ip || "NoName",
    host?.os || "Unknown",
    host?.mac || "Unknown",
    ports || "no_ports",
    nextHop,
    network,
    interfaceName,
    lastSeen,
    onlineStatus,
  ];
}

export function remoteHostsToLegacyRows(hosts = []) {
  return hosts.map((host, idx) => remoteHostToRow(host, idx));
}
