// A chain of six wrappers: dashlint follows five.
import posthog from 'posthog-js';

export function level1(event: string): void {
  posthog.capture(event);
}

export function level2(event: string): void {
  level1(event);
}

export function level3(event: string): void {
  level2(event);
}

export function level4(event: string): void {
  level3(event);
}

export function level5(event: string): void {
  level4(event);
}

export function level6(event: string): void {
  level5(event);
}
