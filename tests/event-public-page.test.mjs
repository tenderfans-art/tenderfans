import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const { eventPublicPage: resolve } = typescriptLoader()('lib/event-public-page.ts');
const website = 'https://venue.example.com/';
const event = fields => ({ events: { venues: { website_url: website } }, ...fields });

test('prefer an explicit public event permalink over its containing schedule page', () => {
  assert.equal(resolve([event({
    source_url: 'https://publisher.example.com/events/performance/',
    publisher: { source_url: 'https://publisher.example.com/api/events', public_page_url: 'https://publisher.example.com/calendar/' },
  })]), 'https://publisher.example.com/events/performance/');
});

test('embedded calendars, data APIs, and uploaded media use their recorded public page', () => {
  for (const source_url of [
    'https://calendar.google.com/calendar/embed?src=calendar-id',
    'https://www.google.com/calendar/event?eid=calendar-event',
    'https://google.com/calendar/event?eid=calendar-event',
    'webcal://publisher.example.com/calendar.ics',
    'https://calendar.google.com/calendar/u/0/r/month',
    'https://publisher.example.com/calendar.ics',
    'https://publisher.example.com/?post_type=events&ical=1',
    'https://publisher.example.com/api/events',
    'https://publisher.example.com/wp-json/tribe/events/v1/events',
    'https://publisher.example.com/widget/calendar',
    'https://publisher.example.com/uploads/November26.pdf',
    'https://publisher.example.com/uploads/music.png',
  ]) {
    assert.equal(resolve([event({ source_url, publisher: { source_url, public_page_url: website + 'entertainment/' } })]), website + 'entertainment/', source_url);
  }
});

test('use previously retained public-page provenance from the candidate', () => {
  assert.equal(resolve([event({
    source_url: 'https://calendar.google.com/calendar/event?eid=event-id',
    candidate: { source_page_url: website + 'events/' },
  })]), website + 'events/');
});

test('consider every source before falling back to a website', () => {
  assert.equal(resolve([
    event({ source_url: 'https://publisher.example.com/calendar.ics' }),
    event({ source_url: 'https://publisher.example.com/event/performance/' }),
  ]), 'https://publisher.example.com/event/performance/');
});

test('a public source page remains usable when the event has no deeper permalink', () => {
  assert.equal(resolve([event({
    source_url: 'https://publisher.example.com/calendar/',
    publisher: { source_url: 'https://publisher.example.com/calendar/' },
  })]), 'https://publisher.example.com/calendar/');
});

test('legacy records use the venue website, and missing public destinations retain TF details', () => {
  assert.equal(resolve([event({ source_url: 'https://publisher.example.com/calendar.ics' })]), website);
  assert.equal(resolve([{ source_url: 'https://publisher.example.com/calendar.ics' }]), null);
});

test('unsafe or technical metadata cannot override a public website', () => {
  for (const public_page_url of ['javascript:alert(1)', 'https://name:password@publisher.example/', 'https://publisher.example.com/feed.xml']) {
    assert.equal(resolve([event({ source_url: null, publisher: { public_page_url } })]), website);
  }
});
