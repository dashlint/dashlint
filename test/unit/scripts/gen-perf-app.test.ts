import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_COUNT, eventName, generate } from '../../../scripts/gen-perf-app.mjs';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'dashlint-perfgen-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function count(dir: string): number {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(
    (e) => e.isFile() && e.name.endsWith('.ts'),
  ).length;
}

describe('gen-perf-app', () => {
  it('writes the requested number of source files and tiles', () => {
    const out = scratch();
    const r = generate({ out, files: 30, tiles: 12, adminFiles: 4 });
    expect(r).toEqual({ files: 30, tiles: 12, adminFiles: 4 });
    expect(count(join(out, 'web/src'))).toBe(30);
    expect(count(join(out, 'admin/src'))).toBe(4);
    const req = JSON.parse(readFileSync(join(out, 'dashlint.requirements.json'), 'utf8')) as {
      tiles: { id: string }[];
    };
    expect(req.tiles).toHaveLength(12);
    expect(new Set(req.tiles.map((t) => t.id)).size).toBe(12);
  });

  it('is deterministic: two runs write the same bytes', () => {
    const a = scratch();
    const b = scratch();
    generate({ out: a, files: 10, tiles: 5, adminFiles: 2 });
    generate({ out: b, files: 10, tiles: 5, adminFiles: 2 });
    for (const rel of [
      'web/src/area3/module3.ts',
      'dashlint.requirements.json',
      'dashlint.config.yml',
    ]) {
      expect(readFileSync(join(a, rel), 'utf8')).toBe(readFileSync(join(b, rel), 'utf8'));
    }
  });

  it('uses 200 distinct event names and every tile names one the app sends', () => {
    const names = new Set(Array.from({ length: EVENT_COUNT }, (_, i) => eventName(i)));
    expect(names.size).toBe(EVENT_COUNT);
    expect(eventName(EVENT_COUNT + 5)).toBe(eventName(5));
    const out = scratch();
    generate({ out, files: 40, tiles: 20, adminFiles: 0 });
    const source = readFileSync(join(out, 'web/src/area0/module0.ts'), 'utf8');
    expect(source).toContain(`posthog.capture('${eventName(0)}'`);
  });

  it('writes no em dash or en dash', () => {
    const out = scratch();
    generate({ out, files: 3, tiles: 3, adminFiles: 1 });
    const text = readFileSync(join(out, 'web/src/area0/module0.ts'), 'utf8');
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    expect(text).not.toMatch(dashes);
  });
});
