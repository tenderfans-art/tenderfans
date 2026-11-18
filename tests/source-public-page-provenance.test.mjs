import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const load = typescriptLoader({
  './browser-transport': { fetchBrowserEvidence: () => assert.fail('Metadata capture must not start browser work') },
}, (text, file) => file.endsWith('/first-party/source-detector.ts')
  ? text + '\nexport { inspectPage, inspectObservedBrowserUrl };' : text);
const { inspectPage, inspectObservedBrowserUrl } = load('lib/event-harvester/first-party/source-detector.ts');
const embed = 'https://calendar.google.com/calendar/embed?src=public-calendar';
const page = 'https://venue.example.com/live-music/';

test('static embed discovery retains the containing public page without changing source identity', () => {
  const detections = [];
  inspectPage(`<html><iframe src="${embed}"></iframe></html>`, page, detections);
  const source = detections.find(d => d.sourceType === 'google_calendar');
  assert.equal(source.url, embed);
  assert.equal(source.publicPageUrl, page);
  assert.equal(source.confidence, 'high');
  assert.equal(source.adapterAvailable, true);
});

test('browser-observed sources retain their rendered containing page', () => {
  const detections = [];
  inspectObservedBrowserUrl(embed, detections, page);
  assert.equal(detections.find(d => d.url === embed).publicPageUrl, page);
});

test('rediscovery preserves source deduplication and the first verified containing page', () => {
  const detections = [];
  const html = `<html><iframe src="${embed}"></iframe></html>`;
  inspectPage(html, page, detections);
  inspectPage(html, 'https://venue.example.com/other-calendar/', detections);
  const sources = detections.filter(d => d.sourceType === 'google_calendar');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, embed);
  assert.equal(sources[0].publicPageUrl, page);
});
