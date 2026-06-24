import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  LabelList
} from "recharts";
import { interpolate, useCurrentFrame } from "remotion";

interface DataPoint {
  label: string;
  value: number;
}

interface BarChartProps {
  data?: DataPoint[];
  title?: string;
  color?: string;
}

export default function BarChart({
  data = [],
  title = "",
  color = "#6c63ff"
}: BarChartProps) {
  const frame = useCurrentFrame();

  const maxValue = Math.max(...data.map((d) => d.value), 1);

  const progress = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp"
  });

  const animatedData = data.map((d) => ({
    ...d,
    animatedValue: d.value * progress
  }));

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#1a1a2e",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "60px 80px",
        boxSizing: "border-box"
      }}
    >
      {title && (
        <h2
          style={{
            color: "#ffffff",
            fontSize: 64,
            fontWeight: 700,
            marginBottom: 48,
            textAlign: "center",
            fontFamily: "sans-serif"
          }}
        >
          {title}
        </h2>
      )}
      <div style={{ width: "100%", flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart
            data={animatedData}
            margin={{ top: 40, right: 40, left: 40, bottom: 40 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.1)"
            />
            <XAxis
              dataKey="label"
              tick={{ fill: "#ffffff", fontSize: 28, fontFamily: "sans-serif" }}
              axisLine={{ stroke: "rgba(255,255,255,0.3)" }}
              tickLine={false}
            />
            <YAxis
              domain={[0, maxValue]}
              tick={{ fill: "#ffffff", fontSize: 24, fontFamily: "sans-serif" }}
              axisLine={{ stroke: "rgba(255,255,255,0.3)" }}
              tickLine={false}
            />
            <Bar
              dataKey="animatedValue"
              isAnimationActive={false}
              radius={[8, 8, 0, 0]}
            >
              <LabelList
                dataKey="animatedValue"
                position="top"
                formatter={(v: unknown) => Math.round(Number(v))}
                style={{ fill: "#ffffff", fontSize: 24, fontFamily: "sans-serif" }}
              />
              {animatedData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={color} />
              ))}
            </Bar>
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
