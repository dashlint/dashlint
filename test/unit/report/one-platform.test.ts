// The one-platform line names the platform the counted events come from, not the platforms an
// all-events node adds (ADR-072): a retention tile with an all-events returning entity and a trends
// tile with an all-events DAU series next to a web-only event.
import { describe, expect, it } from 'vitest';

import type { Requirements, Tile } from '../../../src/formats/requirements.js';
import { renderHtml, renderText } from '../../../src/report/index.js';
import { bookshop, requirements } from '../../fixtures/report/bookshop.js';

const LINE = 'sent from web only; android and ios have no call site';

function allEventsRequirements(): Requirements {
  const base = requirements();
  const common = { dashboards: ['dashboard:41'] };
  const tiles: Tile[] = [
    {
      id: 'insight:Rr11',
      title: 'Readers who come back',
      kind: 'retention',
      ...common,
      retention: {
        target: { node: 'event', event: 'review_submitted' },
        returning: { node: 'all-events' },
      },
    },
    {
      id: 'insight:Dr12',
      title: 'Reviews per daily reader',
      kind: 'trends',
      ...common,
      series: [
        { node: 'event', event: 'review_submitted', ref: 'A' },
        { node: 'all-events', math: 'dau', ref: 'B' },
      ],
    },
  ];
  return { ...base, tiles, alerts: [] };
}

describe('one-platform line with an all-events node (ADR-072)', () => {
  const model = bookshop({ requirements: allEventsRequirements(), ignore: [] });

  it('both tiles are one platform and keep every platform in the platforms column', () => {
    expect(model.report.tiles.map((t) => [t.id, t.verdict, t.platforms])).toEqual([
      ['insight:Rr11', 'one-platform', ['android', 'ios', 'web']],
      ['insight:Dr12', 'one-platform', ['android', 'ios', 'web']],
    ]);
    expect(model.fedFrom).toEqual({ 'insight:Rr11': ['web'], 'insight:Dr12': ['web'] });
  });

  it('text names web as the only platform and android and ios as missing', () => {
    const text = renderText(model).replace(/\s+/g, ' ');
    expect(text.split(LINE).length - 1).toBe(2);
    expect(text).not.toContain('android, ios and web only');
  });

  it('HTML names web as the only platform and android and ios as missing', () => {
    const html = renderHtml(model).replace(/\s+/g, ' ');
    expect(html.split(LINE).length - 1).toBe(2);
    expect(html).not.toContain('android, ios and web only');
  });
});
