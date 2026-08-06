import type { SVGProps } from "react";

/**
 * Minimal outline icon set for the workflow UI. Deliberately generic
 * (camera / cloud / server shapes, not brand logos) — keeps the diagram
 * legally safe and maintainable as we add clouds/destinations, per the
 * product decision to avoid real company logos.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(props: IconProps) {
  const { size = 16, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...rest,
  };
}

export function IconCamera(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 8a2 2 0 0 1 2-2h2.2l1-1.5h7.6l1 1.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </svg>
  );
}

export function IconFilm(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 15h18M8 4v5M8 15v5M16 4v5M16 15v5" />
    </svg>
  );
}

export function IconCloud(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7.5 18a4 4 0 0 1-.5-7.97A5 5 0 0 1 17 9.5a3.7 3.7 0 0 1 3 3.6c0 2-1.6 3.4-3.6 3.4Z" />
    </svg>
  );
}

export function IconLaptop(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="5" width="16" height="10" rx="1.4" />
      <path d="M2 18.5h20" />
    </svg>
  );
}

export function IconServer(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="4" width="17" height="6.2" rx="1.4" />
      <rect x="3.5" y="13.8" width="17" height="6.2" rx="1.4" />
      <path d="M7 7.1h.01M7 16.9h.01" />
    </svg>
  );
}

export function IconBroadcast(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="1.6" />
      <path d="M8.3 15.7a5 5 0 0 1 0-7.4M15.7 15.7a5 5 0 0 0 0-7.4M5.3 18.7a9.4 9.4 0 0 1 0-13.4M18.7 18.7a9.4 9.4 0 0 0 0-13.4" />
    </svg>
  );
}

export function IconTarget(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function IconMonitor(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4.5" width="18" height="12" rx="1.6" />
      <path d="M8 20h8M12 16.5V20" />
    </svg>
  );
}

export function IconGauge(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 16a7.5 7.5 0 1 1 15 0" />
      <path d="M12 16 15 11" />
      <path d="M4.5 16h15" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

export function IconAlertTriangle(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4 21.5 20H2.5Z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12h16M14 6l6 6-6 6" />
    </svg>
  );
}
