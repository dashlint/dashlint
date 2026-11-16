// ADR-070 A in TypeScript: a declared type is read as before.
import posthog from 'posthog-js';

export function coverZoomed(size: string | null = null): void {
  posthog.capture('cover_zoomed', { size });
}

export function formatPicked(format: 'paperback' | null = null): void {
  posthog.capture('format_picked', { format });
}

// No declared type: open, as in JavaScript.
export function spineRead(label = null): void {
  posthog.capture('spine_read', { label });
}
