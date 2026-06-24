import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer
} from "recharts";
import { interpolate, useCurrentFrame } from "remotion";

interface DataPoint {
  label: string;
  value: number;
}

interface LineChartProps {
  points?: DataPoint[];
  title?: string;
  color?: string;
}

export default function LineChart({
  points = [],
  title = "",
  color = "#6c63ff"
}: LineChartProps) {
  const frame = useCurrentFrame();

  const progress = interpolate(frame, [0, 60], [0, 1], {
    extrapolateRight: "clamp"
  });

  const visibleCount = Math.max(1, Math.ceil(progress * points.length));
  const visibleData = points.slice(0, visibleCount).map((p, i) => {
    if (i < visibleCount - 1) return p;
    const prevCount = visibleCount - 1;
    const segProgress =
      points.length > 1 ? progress * points.length - prevCount : 1;
    return {
      ...p,
      value:
        prevCount > 0
          ? points[prevCount - 1].value +
            (p.value - points[prevCount - 1].value) * segProgress
          : p.value * segProgress
    };
  });

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
          <RechartsLineChart
            data={visibleData}
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
              tick={{ fill: "#ffffff", fontSize: 24, fontFamily: "sans-serif" }}
              axisLine={{ stroke: "rgba(255,255,255,0.3)" }}
              tickLine={false}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={6}
              dot={{ fill: color, r: 8, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </RechartsLineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
