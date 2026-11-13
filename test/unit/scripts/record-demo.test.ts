import { describe, expect, it } from 'vitest';
import { leaks, referenced } from '../../../scripts/record-demo.mjs';

describe('record-demo', () => {
  it('finds the key, PostHog keys and tokens, and email addresses in a recording', () => {
    const key = 'phx_RecorderTestKey123';
    expect(leaks('{"name":"Bookshop growth"}', key)).toEqual([]);
    expect(leaks(`{"detail":"${key}"}`, key)).toContain('the key');
    expect(leaks('{"label":"phc_aaaaaaaaaaaa"}', key)).toEqual([
      'a PostHog key or token (phc_...)',
    ]);
    expect(leaks('{"by":"reader@shop.example"}', key)).toEqual([
      'an email address (...@shop.example)',
    ]);
  });

  it('collects the events and actions that queries reference', () => {
    const insights = [
      {
        query: {
          kind: 'InsightVizNode',
          source: {
            series: [
              { kind: 'EventsNode', event: 'book_viewed' },
              { kind: 'EventsNode', event: null },
              { kind: 'ActionsNode', id: 12 },
            ],
          },
        },
      },
      { query: null },
    ];
    const { events, actions } = referenced(insights) as {
      events: Set<string>;
      actions: Set<string>;
    };
    expect([...events]).toEqual(['book_viewed']);
    expect([...actions]).toEqual(['12']);
  });
});
