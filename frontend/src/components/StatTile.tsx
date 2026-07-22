export interface StatTileProps {
  label: string;
  primaryValue: string;
  secondaryValue?: string;
}

export function StatTile({ label, primaryValue, secondaryValue }: StatTileProps) {
  return (
    <div className="stat-tile">
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{primaryValue}</div>
      {secondaryValue && <div className="stat-tile-secondary">{secondaryValue}</div>}
    </div>
  );
}
