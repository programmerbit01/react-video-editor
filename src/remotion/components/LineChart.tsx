import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceDot
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
  yLabel?: string;
  xLabel?: string;
}

export default function LineChart({
  points = [],
  title = "",
  color = "#6c63ff",
  yLabel = "",
  xLabel = ""
}: LineChartProps) {
  const frame = useCurrentFrame();

  // All points visible from frame 0; each Y-value animates from 0 → final
  // so the line "rises" into place rather than drawing point-by-point.
  const progress = interpolate(frame, [0, 60], [0, 1], {
    extrapolateRight: "clamp"
  });

  const animatedData = points.map((p) => ({
    ...p,
    value: p.value * progress
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
          <RechartsLineChart
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
              label={
                xLabel
                  ? {
                      value: xLabel,
                      position: "insideBottom",
                      offset: -10,
                      fill: "rgba(255,255,255,0.6)",
                      fontSize: 22,
                      fontFamily: "sans-serif"
                    }
                  : undefined
              }
            />
            <YAxis
              domain={[0, Math.max(...points.map((p) => p.value), 1)]}
              tick={{ fill: "#ffffff", fontSize: 24, fontFamily: "sans-serif" }}
              axisLine={{ stroke: "rgba(255,255,255,0.3)" }}
              tickLine={false}
              label={
                yLabel
                  ? {
                      value: yLabel,
                      angle: -90,
                      position: "insideLeft",
                      offset: 10,
                      fill: "rgba(255,255,255,0.6)",
                      fontSize: 22,
                      fontFamily: "sans-serif"
                    }
                  : undefined
              }
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
