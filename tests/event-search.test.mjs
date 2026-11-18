import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const load = typescriptLoader();
const { eventSearchMetadata, publicCalendarEvent } = load('lib/event-search-metadata.ts');
const { matchesEventSearch, buildPerformerCatalog } = load('lib/event-search.ts');
function event(title, candidate = {}, fields = {}) {
  const row = { title, ...fields, event_source_links: [{ candidate: { status: 'graduated', ...candidate } }] };
  return { ...row, search_metadata: eventSearchMetadata(row) };
}

test('name-only performances use retained genre, event type and publisher categories', () => {
  for (const candidate of [
    { performer: { name: 'Example Artist', genre: 'Jazz' } },
    { structured_type: ['Event', 'MusicEvent'] },
    { performer: { '@type': 'MusicGroup', name: 'Example Artist' } },
    { categories: [{ name: 'Live Music', slug: 'live-music' }] },
    { category: 'Jazz' },
    { classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' } }] },
  ]) assert.equal(matchesEventSearch(event('Example Artist', candidate), 'music'), true);
  const jazz = event('Example Artist', { performer: { name: 'Example Artist', genre: 'Jazz' } });
  assert.equal(matchesEventSearch(jazz, 'jazz'), true);
  assert.equal(matchesEventSearch(jazz, 'comedy'), false);
});

test('existing image evidence and broad entertainment labels find bare names without reparsing', () => {
  for (const candidate of [
    { calendar_context: 'A monthly live music schedule with dated performances.' },
    { calendar_context: 'Monthly venue entertainment calendar.' },
    { image_event_context: ['November Entertainment', 'Tuesday column'] },
    { calendar_name: 'Live Music Schedule' },
    { calendar_description: 'Public music and events' },
  ]) assert.equal(matchesEventSearch(event('Example Artist', candidate), 'music'), true);
});

test('mixed calendar context does not reclassify explicit meals, sports, games, drinks or comedy', () => {
  for (const title of ['Breakfast', 'Thursday Night Football', 'Trivia', 'Happy Hour', 'Stand-up Comedy']) {
    const row = event(title, { calendar_name: 'Live Music and Entertainment', image_event_context: ['Live music calendar', 'Sunday'] });
    assert.equal(matchesEventSearch(row, 'music'), false, title);
  }
  assert.equal(matchesEventSearch(event('Music Bingo', { calendar_name: 'Entertainment' }), 'music'), true);
  assert.equal(matchesEventSearch(event('DJ + Dinner', { performer: { genre: 'DJ' } }), 'music'), true);
  assert.equal(matchesEventSearch(event('Example Artist', { calendar_context: 'Live music calendar with weekly food and drink specials' }), 'food'), false);
});

test('literal searches, accents, locations, ZIPs and combined category/location terms work', () => {
  const row = event('LeMay O’James', { performer: { name: 'LeMay O’James', genre: 'Jazz' } }, {
    venue_name: 'Example Brewery', venue_city: 'Saint Petersburg', venue_postal_code: '33701',
    description: '<p>Résumé performance</p>',
  });
  for (const query of ['LeMay', "lemay o'james", 'resume', 'brewery', 'St. Petersburg', '33701', 'music St Pete', 'jazz 33701', 'music brewery']) {
    assert.equal(matchesEventSearch(row, query), true, query);
  }
  assert.equal(matchesEventSearch(row, 'music 99999'), false);
  assert.equal(matchesEventSearch(row, 'music Tampa'), false);
});

test('classification is evidence based without venue, URL or adapter defaults', () => {
  for (const candidate of [
    {}, { performer: 'Organization', structured_type: 'Event' },
    { source_type: 'gotonight_events', provider: 'gotonight', source_url: 'https://music.example/' },
    { performer: { '@type': 'Organization', name: 'Publisher' } },
    { status: 'suppressed', performer: { genre: 'Jazz', name: 'Example Artist' } },
  ]) assert.equal(matchesEventSearch(event('Unknown Name', candidate), 'music'), false);
  for (const title of ['Husband Appreciation', 'Rock Paper Scissors', 'Open House', 'Country Market']) {
    assert.equal(matchesEventSearch(event(title), 'music'), false, title);
  }
});

test('exact corroborated artist names can match elsewhere without classifying unrelated or ambiguous entries', () => {
  const known = event('LIVE MUSIC: Example Artist', { performer: { name: 'Example Artist', genre: 'Jazz' } });
  const catalog = buildPerformerCatalog([known, event('Saturday', { calendar_context: 'Entertainment calendar' })]);
  assert.equal(matchesEventSearch(event('Example Artist'), 'music', catalog), true);
  assert.equal(matchesEventSearch(event('Example Artist Jr'), 'music', catalog), false);
  assert.equal(matchesEventSearch(event('Saturday'), 'music', catalog), false);
  assert.equal(matchesEventSearch(event('Example Artist', { categories: ['Sports'] }), 'music', catalog), false);
});

test('only public hints leave the server, never provenance, review explanations or raw payload', () => {
  const projected = publicCalendarEvent({ id: 'event-id', title: 'Example Artist', event_source_links: [{ candidate: {
    status: 'graduated', performer: { name: 'Example Artist', genre: 'Jazz', private_note: 'PRIVATE' },
    calendar_context: 'Monthly music calendar. PRIVATE qualification reasoning.', raw_payload: { secret: 'PRIVATE' },
  }, source_id: 'PRIVATE' }] });
  assert.equal(matchesEventSearch(projected, 'music'), true);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|event_source_links|raw_payload|calendar_context/);
});
