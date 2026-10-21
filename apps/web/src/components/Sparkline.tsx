/** Tiny inline trend line. Decorative: the value is always shown as text next to it. */
export function Sparkline({
  points,
  width = 84,
  height = 26,
  label,
}: {
  points: number[];
  width?: number;
  height?: number;
  label?: string;
}) {
  if (points.length < 2)
    return (
      <span className="muted small" aria-hidden>
        ·
      </span>
    );
  const lo = Math.min(...points),
    hi = Math.max(...points);
  const span = hi - lo || 1;
  const xy = points.map(
    (p, i) =>
      [
        (i / (points.length - 1)) * (width - 4) + 2,
        height - 3 - ((p - lo) / span) * (height - 6),
      ] as const,
  );
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const up = points[points.length - 1]! >= points[0]!;
  const last = xy[xy.length - 1]!;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `Trend ${up ? 'up' : 'down'}`}
      className="sens"
    >
      <path
        d={d}
        fill="none"
        stroke={up ? 'var(--success)' : 'var(--danger)'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill={up ? 'var(--success)' : 'var(--danger)'} />
    </svg>
  );
}
