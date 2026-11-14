// The calls of the edge wrappers.
import sendDefault from '../lib/default-sender';
import { level5, level6 } from '../lib/chain';
import {
  aliased8,
  aliased9,
  Counter,
  dotted8,
  dotted9,
  keyed8,
  keyed9,
  makeSpreadTracker,
  makeTracker,
  Till,
  trackComputed,
  trackFirst,
  trackFormat,
  trackKeyed,
  trackNamed,
  trackRest,
  trackRestPicked,
  trackTag,
} from '../lib/edges';
import { trackLabelled, trackOuter, trackUnlabelled } from '../lib/labels';
import { storyTrack } from './card.stories';

const CHIME = 'chime';

export function openTill(till: Till): void {
  trackFormat('format_chosen');
  till.ring('till_opened');
  till[CHIME]('chime_rung');
  new Counter().tally('copies_counted');
  trackTag('tag_added');
  trackNamed('named_sent');
  trackKeyed({ name: 'keyed_sent' });
  trackRest('rest_sent');
  trackRestPicked({ name: 'rest_picked' });
  trackFirst(['first_sent']);
  trackComputed({ name: 'computed_sent' });
  sendDefault('default_sent');
  makeTracker({ source: 'till' })('made_sent');
  makeSpreadTracker({ source: 'till' })('spread_sent');
  aliased8('alias_eight');
  aliased9('alias_nine');
  trackLabelled('labelled_sent', 'till');
  trackOuter('outer_sent');
  trackUnlabelled('unlabelled_sent');
  storyTrack('story_sent');
  level5('five_deep');
  level6('six_deep');
  void [trackTag('same_line_a'), trackTag('same_line_b')];
}

export function readDeep(): void {
  dotted8({} as any);
  dotted9({} as any);
  keyed8({} as any);
  keyed9({} as any);
}
