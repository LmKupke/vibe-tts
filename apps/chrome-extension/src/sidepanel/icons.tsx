import type { JSX, ReactNode } from "react";

interface IconProps {
  children: ReactNode;
  size?: number | undefined;
}

function Icon({ children, size = 20 }: IconProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function PlayIcon({ size }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M8.4 5.7v12.6L18 12 8.4 5.7Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PauseIcon({ size }: { size?: number }): JSX.Element {
  return (
    <Icon size={size}>
      <path d="M9 6v12M15 6v12" strokeWidth="2.6" />
    </Icon>
  );
}

export function StopIcon(): JSX.Element {
  return (
    <Icon>
      <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PreviousIcon(): JSX.Element {
  return (
    <Icon>
      <path d="M6 6v12M18 7.5 9 12l9 4.5v-9Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function NextIcon(): JSX.Element {
  return (
    <Icon>
      <path d="M18 6v12M6 7.5l9 4.5-9 4.5v-9Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function SelectionIcon(): JSX.Element {
  return (
    <Icon>
      <path d="M5 8V5h3M16 5h3v3M19 16v3h-3M8 19H5v-3" />
      <path d="M9 9h6M9 12h6M9 15h4" />
    </Icon>
  );
}

export function RefreshIcon(): JSX.Element {
  return (
    <Icon size={16}>
      <path d="M19 8a7 7 0 0 0-12-2L5 8M5 5v3h3M5 16a7 7 0 0 0 12 2l2-2M19 19v-3h-3" />
    </Icon>
  );
}

export function VolumeIcon(): JSX.Element {
  return (
    <Icon size={18}>
      <path d="M5 10v4h3l4 3V7l-4 3H5Z" />
      <path d="M15 9.5a4 4 0 0 1 0 5M17.5 7a7.5 7.5 0 0 1 0 10" />
    </Icon>
  );
}

export function ChevronIcon(): JSX.Element {
  return (
    <Icon size={14}>
      <path d="m8 10 4 4 4-4" />
    </Icon>
  );
}
