import { interpolate, useCurrentFrame } from "remotion";

interface StatCardProps {
  value?: number;
  label?: string;
  prefix?: string;
  suffix?: string;
}

export default function StatCard({
  value = 0,
  label = "",
  prefix = "",
  suffix = ""
}: StatCardProps) {
  const frame = useCurrentFrame();

  // Start at 2% of value at frame 0 so the number is non-zero immediately
  const animatedValue = interpolate(frame, [0, 45], [value * 0.02, value], {
    extrapolateRight: "clamp"
  });

  const displayValue = Math.round(animatedValue).toLocaleString();

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
        fontFamily: "sans-serif"
      }}
    >
      <div
        style={{
          fontSize: 120,
          fontWeight: 900,
          color: "#ffffff",
          lineHeight: 1,
          textShadow: "0 0 40px #6c63ff",
          letterSpacing: "-2px"
        }}
      >
        {prefix}
        {displayValue}
        {suffix}
      </div>
      {label && (
        <div
          style={{
            fontSize: 48,
            color: "rgba(255,255,255,0.7)",
            marginTop: 32,
            fontWeight: 400,
            letterSpacing: "1px"
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
