import { Line, LineChart, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface TimeSeriesChartProps {
  title: string;
  data: TimeSeriesPoint[];
  color: string;
  valueFormatter: (value: number) => string;
}

export function TimeSeriesChart({ title, data, color, valueFormatter }: TimeSeriesChartProps) {
  return (
    <div className="chart-card">
      <h2 className="chart-title">{title}</h2>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--gridline)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" stroke="var(--axis)" tick={{ fill: "var(--text-muted)", fontSize: 12 }} />
          <YAxis
            stroke="var(--axis)"
            tick={{ fill: "var(--text-muted)", fontSize: 12 }}
            tickFormatter={valueFormatter}
            width={64}
          />
          <Tooltip
            formatter={(value: number) => valueFormatter(value)}
            contentStyle={{ background: "var(--surface-card)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            labelStyle={{ color: "var(--text-secondary)" }}
          />
          <Line type="monotone" dataKey="value" name={title} stroke={color} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
