import { spring, useCurrentFrame, useVideoConfig } from "remotion";

interface BulletListProps {
  items?: string[];
  title?: string;
  emoji?: string;
}

export default function BulletList({
  items = [],
  title = "",
  emoji = "✅"
}: BulletListProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#1a1a2e",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "80px 120px",
        boxSizing: "border-box",
        fontFamily: "sans-serif"
      }}
    >
      {title && (
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            color: "#6c63ff",
            marginBottom: 48
          }}
        >
          {title}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 32, width: "100%" }}>
        {items.map((item, index) => {
          const delay = index * 15;
          const localFrame = Math.max(0, frame - delay);

          const slideProgress = spring({
            frame: localFrame,
            fps,
            config: { damping: 14, stiffness: 100, mass: 0.8 }
          });

          const opacity = spring({
            frame: localFrame,
            fps,
            config: { damping: 20, stiffness: 120, mass: 0.5 }
          });

          const translateX = (1 - slideProgress) * -60;

          return (
            <div
              key={index}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 24,
                opacity,
                transform: `translateX(${translateX}px)`
              }}
            >
              <span style={{ fontSize: 48, flexShrink: 0 }}>{emoji}</span>
              <span
                style={{
                  fontSize: 48,
                  color: "#ffffff",
                  fontWeight: 400,
                  lineHeight: 1.3
                }}
              >
                {item}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
