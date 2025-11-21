export function SelectedNodePanel({ node, subnet, route }) {
  if (!node && !subnet && !route) return null;

  const title = node
    ? node.group === "network"
      ? "Docker Network"
      : "Host Details"
    : subnet
    ? "Subnet Info"
    : "Route";

  return (
    <div className="bg-white border shadow rounded p-4 text-sm w-80">
      <h3 className="font-semibold mb-3">{title}</h3>

      {/* Subnet node */}
      {subnet && (
        <div className="space-y-1">
          <div><strong>Name:</strong> {subnet.label}</div>
          <div><strong>Prefix:</strong> {subnet.subnet}</div>
        </div>
      )}

      {/* Docker Network Node */}
      {node?.group === "network" && (
        <div className="space-y-1">
          <div><strong>Name:</strong> {node.name}</div>
          <div><strong>Prefix:</strong> {node.subnet}</div>
        </div>
      )}

      {/* Normal or Docker Host */}
      {node && (node.group === "normal" || node.group === "docker") && (
        <div className="space-y-1">
          <div><strong>Name:</strong> {node.name}</div>
          <div><strong>IP:</strong> {node.ip}</div>
          <div><strong>OS:</strong> {node.os}</div>
          <div><strong>Status:</strong> {node.online_status || "unknown"}</div>
          <div><strong>MAC:</strong> {node.mac}</div>
          <div><strong>Ports:</strong> {node.ports}</div>
          <div><strong>Subnet:</strong> {node.subnet}</div>
          <div><strong>Risk Group:</strong> {node.riskGroup}</div>
          <div><strong>Network:</strong> {node.network_name}</div>
          <div><strong>Last Seen:</strong> {node.last_seen}</div>
        </div>
      )}

      {/* Inter-subnet route */}
      {route && (
        <div className="space-y-1">
          <div><strong>Route:</strong></div>
          <div>{route.from} → {route.to}</div>
        </div>
      )}
    </div>
  );
}
