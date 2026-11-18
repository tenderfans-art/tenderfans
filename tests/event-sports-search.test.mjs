import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const load = typescriptLoader();
const { eventSearchMetadata } = load('lib/event-search-metadata.ts');
const { matchesEventSearch } = load('lib/event-search.ts');
function event(title, candidate = {}, fields = {}) {
  const row = { title, ...fields, event_source_links: [{ candidate: { status: 'graduated', ...candidate } }] };
  return { ...row, search_metadata: eventSearchMetadata(row) };
}

test('sports finds missing motorsport, combat, running, rugby and recreational sports', () => {
  for (const title of ['F1 Race Day', 'Formula One Grand Prix', 'NASCAR', 'Wrestling Charity Event',
    'Boxing Night', 'MMA Main Card', 'Community Runfest', 'Half Marathon', '5K Fun Run',
    'Rugby Sevens', 'Cricket Final', 'Pickleball Tournament', 'Volleyball', 'Billiards', 'Darts League']) {
    assert.equal(matchesEventSearch(event(title), 'sports'), true, title);
    assert.equal(matchesEventSearch(event(title), 'sport'), true, title);
  }
  assert.equal(matchesEventSearch(event('First Fight', {}, { description: 'Gates: 4 PM\nFirst Fight: 4:30 PM' }), 'sports'), true);
});

test('matchup-only titles work across competitors and punctuation without team-specific lists', () => {
  for (const title of ['Alabama Vs Vanderbilt', 'BUCS vs. PANTHERS', '🏉 France v Springboks',
    'Northbridge versus Southbridge', 'Northbridge VS. Southbridge Watch Party']) {
    const row = event(title, { calendar_name: 'Live Music & Entertainment' });
    assert.equal(matchesEventSearch(row, 'sports'), true, title);
    assert.equal(matchesEventSearch(row, 'music'), false, title);
  }
  assert.equal(matchesEventSearch(event('Northbridge vs Southbridge', {}, { description: 'Cold beer and food specials.' }), 'sports'), true);
});

test('versus in musical battles, tastings, screenings or debates is not enough for sports', () => {
  for (const title of ['Rock vs Country Tribute Night', 'Beer vs Wine Tasting', 'Godzilla vs Kong Screening',
    'Buy vs Rent Seminar', 'Candidates vs Incumbents Debate', 'Northbridge vs Southbridge Trivia']) {
    assert.equal(matchesEventSearch(event(title), 'sports'), false, title);
  }
  assert.equal(matchesEventSearch(event('Performer A vs Performer B', { structured_type: 'MusicEvent' }), 'sports'), false);
  assert.equal(matchesEventSearch(event('Performer A vs Performer B', {}, { description: 'Two tribute bands in concert.' }), 'sports'), false);
});

test('sports venue names and generic watch parties do not turn unrelated events into sports', () => {
  for (const suffix of ['Sports Bar & Grill', 'Sports Club', 'Sports Lounge']) {
    const row = event('Evening Guest', {}, { venue_name: `Example ${suffix}`, venue_city: 'Saint Petersburg', description: `Live music at Example ${suffix}.` });
    assert.equal(matchesEventSearch(row, 'sports'), false, suffix);
    assert.equal(matchesEventSearch(row, 'sports St Pete'), false, suffix);
    assert.equal(matchesEventSearch(row, `Example ${suffix}`), true, 'Literal Spot searches remain available');
    assert.equal(matchesEventSearch(row, 'music'), true);
  }
  for (const title of ['Movie Watch Party', 'Election Watch Party', 'Movie Marathon', 'Squash Soup Night']) {
    assert.equal(matchesEventSearch(event(title), 'sports'), false, title);
  }
  const music = event('Evening Guest', {}, { description: 'Live music. Venue amenities include 28 TVs for sports viewing.' });
  assert.equal(matchesEventSearch(music, 'sports'), false);
});

test('retained sport, home/away and typed competitors provide public search evidence', () => {
  for (const candidate of [
    { sport: 'Rugby' }, { structured_type: ['Event', 'SportsEvent'] },
    { home_team: { name: 'Northbridge' }, away_team: { name: 'Southbridge' } },
    { competitors: [{ '@type': 'SportsTeam', name: 'Northbridge' }] },
    { home_team: { '@type': 'SportsTeam', name: 'Northbridge' } },
    { classifications: [{ segment: { name: 'Sports' }, genre: { name: 'Boxing' } }] },
  ]) assert.equal(matchesEventSearch(event('Opening Round', candidate), 'sports'), true);
  const row = event('Opening Round', { sport: 'Rugby', home_team: 'Northbridge', away_team: 'Southbridge' }, { venue_city: 'Saint Petersburg', venue_postal_code: '33701' });
  for (const query of ['rugby', 'Northbridge', 'Southbridge', 'sports St Pete', 'rugby 33701']) assert.equal(matchesEventSearch(row, query), true, query);
  assert.equal(matchesEventSearch(row, 'sports Tampa'), false);
});

test('athletes and teams are not treated as musical performers', () => {
  for (const type of ['SportsTeam', 'https://schema.org/SportsTeam', 'Athlete']) {
    const row = event('Northbridge', { performer: { '@type': type, name: 'Northbridge' } });
    assert.equal(matchesEventSearch(row, 'sports'), true);
    assert.equal(matchesEventSearch(row, 'music'), false);
    assert.deepEqual(row.search_metadata.performers, []);
  }
});

test('round-only titles use explicit sports-calendar context without inheriting it for unrelated items', () => {
  const candidate = { image_event_context: ['WOMEN’S GOLF'], calendar_context: 'Monthly public sports calendar' };
  assert.equal(matchesEventSearch(event('Opening Round', candidate), 'sports'), true);
  for (const title of ['Breakfast', 'Example Artist', 'Trivia Final', 'Comedy Final']) {
    assert.equal(matchesEventSearch(event(title, candidate), 'sports'), false, title);
  }
});

test('missing or rejected evidence and mixed calendar headings do not classify a meal as sports', () => {
  for (const candidate of [
    { sport: '', home_team: '', away_team: '' },
    { status: 'suppressed', sport: 'Rugby' },
    { calendar_name: 'Sports and Entertainment Calendar' },
  ]) assert.equal(matchesEventSearch(event('Breakfast', candidate), 'sports'), false);
});
