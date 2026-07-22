import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

const SLOT_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

export interface HorizontalBarChartEntry {
  label: string;
  value: number;
}

export interface HorizontalBarChartProps {
  title: string;
  data: HorizontalBarChartEntry[];
  valueFormatter: (value: number) => string;
}

export function HorizontalBarChart({ title, data, valueFormatter }: HorizontalBarChartProps) {
  return (
    <div className="chart-card">
      <h2 className="chart-title">{title}</h2>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="var(--gridline)" strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            stroke="var(--axis)"
            tick={{ fill: "var(--text-muted)", fontSize: 12 }}
            tickFormatter={valueFormatter}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="var(--axis)"
            tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
            width={140}
          />
          <Tooltip
            formatter={(value: number) => valueFormatter(value)}
            contentStyle={{ background: "var(--surface-card)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {data.map((entry, index) => (
              <Cell key={entry.label} fill={SLOT_COLORS[index % SLOT_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
