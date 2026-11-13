// Platforms (spec 6.4 item 9, T3.7): a site's platforms are the source's platforms, narrowed by a
// React Native platform file suffix (`.ios.`, `.android.`, `.web.`, `.native.` = ios and android).
// `Platform.OS` branches are not modelled in v0.1 (a documented limitation).
import type { Platform } from '../descriptors/index.js';

const SUFFIX = /\.(ios|android|web|native)\.[cm]?[jt]sx?$/;

const BY_SUFFIX: Record<string, Platform[]> = {
  ios: ['ios'],
  android: ['android'],
  web: ['web'],
  native: ['ios', 'android'],
};

/** The platforms the file name's suffix restricts it to, or undefined when it has none. */
export function suffixPlatforms(file: string): Platform[] | undefined {
  const suffix = SUFFIX.exec(file)?.[1];
  return suffix === undefined ? undefined : BY_SUFFIX[suffix];
}

/**
 * The platforms of a site in `file`: the source's, narrowed by the file's suffix. A suffix for a
 * platform the source does not list (`share.web.ts` in an ios and android source) keeps the
 * suffix's platforms, so the site is never lost (ADR-027).
 */
export function sitePlatforms(file: string, sourcePlatforms: readonly string[]): string[] {
  const only = suffixPlatforms(file);
  if (!only) return [...sourcePlatforms];
  const narrowed = sourcePlatforms.filter((p) => (only as string[]).includes(p));
  return narrowed.length > 0 ? narrowed : [...only];
}
