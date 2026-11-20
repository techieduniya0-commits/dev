import React from 'react';

interface TruthLensLogoProps {
  compact?: boolean;
}

export const TruthLensLogo: React.FC<TruthLensLogoProps> = ({ compact = false }) => {
  return (
    <div className="flex items-center gap-2.5 shrink-0 select-none">
      <svg
        width={compact ? 24 : 26}
        height={compact ? 24 : 26}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect
          x="1.25"
          y="1.25"
          width="29.5"
          height="29.5"
          rx="6"
          stroke="#2B2D32"
          strokeWidth="1.25"
          fill="#1B1D21"
        />
        <circle cx="16" cy="16" r="8.25" stroke="#D9A441" strokeWidth="1.5" />
        <path
          d="M16 4.75V8.25M16 23.75V27.25M4.75 16H8.25M23.75 16H27.25"
          stroke="#92949B"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
        <path
          d="M12.75 12.75L19.25 19.25M19.25 12.75L12.75 19.25"
          stroke="#F4F3EF"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <circle cx="16" cy="16" r="2.1" fill="#D9A441" />
      </svg>
      <span className="font-semibold tracking-tight text-[#F4F3EF] whitespace-nowrap text-[15px]">
        TruthLens <span className="text-[#D9A441]">X</span>
      </span>
    </div>
  );
};
