import type { Validity } from "@/lib/inspectAttachments";

const config: Record<Validity, { label: string; className: string }> = {
  valid: {
    label: "Valid",
    className: "bg-green-500/15 text-green-700 dark:text-green-400",
  },
  warning: {
    label: "Warning",
    className: "bg-amber-500/15 text-amber-800 dark:text-amber-400",
  },
  invalid: {
    label: "Invalid",
    className: "bg-red-500/15 text-red-700 dark:text-red-400",
  },
};

export function ValidityBadge({ validity }: { validity: Validity }) {
  const { label, className } = config[validity];
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

export function ValidityDot({ validity }: { validity: Validity }) {
  const colors: Record<Validity, string> = {
    valid: "bg-green-500",
    warning: "bg-amber-500",
    invalid: "bg-red-500",
  };
  return <span className={`inline-block size-1.5 rounded-full shrink-0 ${colors[validity]}`} />;
}
