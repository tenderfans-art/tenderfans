import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const load=typescriptLoader();
const {eventSearchMetadata}=load('lib/event-search-metadata.ts');
const {matchesEventSearch,matchesEventFilter,buildPerformerCatalog,EVENT_CATEGORY_FILTERS}=load('lib/event-search.ts');
function event(title,candidate={},fields={}) {
  const row={title,...fields,event_source_links:[{candidate:{status:'graduated',...candidate}}]};
  return {...row,search_metadata:eventSearchMetadata(row)};
}

test('food and drink recognizes seafood, meals, tastings, pairings and missing beverage names',()=>{
  for(const title of ['SNOW CRAB TUESDAYS $25','Raclette Pop-Up','Seafood Boil','Sushi Rolling Class','Cheese & Beer Pairing','Potluck Supper',
    '$25 BOTTOMLESS MIMOSAS','Sangria Sunday','Bourbon Tasting','Cider Release','Mezcal Masterclass','Mocktail Workshop','Paint and Sip']) {
    assert.equal(matchesEventFilter(event(title),'food_drink'),true,title);
  }
  assert.equal(matchesEventSearch(event('SNOW CRAB TUESDAYS $25'),'food'),true);
  assert.equal(matchesEventSearch(event('$25 BOTTOMLESS MIMOSAS'),'drinks'),true);
});

test('food and drink is a union and combines with ordinary text or location searches',()=>{
  const food=event('Sunday Brunch',{}, {venue_city:'Saint Petersburg',venue_postal_code:'33701'});
  const drink=event('Mimosa Flight',{}, {venue_city:'Saint Petersburg',venue_postal_code:'33701'});
  for(const row of [food,drink]) for(const query of ['food and drink','food & drink','food and drinks','food and drink St Pete','food drink 33701']) {
    assert.equal(matchesEventSearch(row,query),true,query);
  }
  assert.equal(matchesEventSearch(food,'food and drink Tampa'),false);
  assert.equal(matchesEventFilter(food,'food_drink')&&matchesEventSearch(food,'brunch'),true);
  assert.equal(matchesEventFilter(drink,'food_drink')&&matchesEventSearch(drink,'brunch'),false);
});

test('generic availability, ticket policies and quiz questions do not imply a food event',()=>{
  for(const description of ['NO OUTSIDE FOOD AND BEVERAGE IS PERMITTED.', 'Tickets are $30. Cold beer and pizza available for purchase.',
    'Enjoy live music, great food and cold beer.', 'Free concert with cold beer and pizza available.',
    'Tickets $30. Join us for music, great food and beer.', 'Survey question: Which fast-food place has the best pizza delivery?',
    'Win a $30 gift card! Great selection of craft beers, ciders and food.']) {
    assert.equal(matchesEventFilter(event('Evening Guest',{}, {description}),'food_drink'),false,description);
  }
});

test('explicit food and drink specials can accompany music, games or sports',()=>{
  for(const [title,description] of [
    ['Trivia Night','Drink specials: $5 mimosas and $10 cocktails.'],
    ['Trivia Night','Enjoy $5 draft beers, or complimentary wine.'],
    ['Live Music','Food truck serving tacos.'],
    ['NFL Watch Party','Beer specials all night: $4 drafts.'],
    ['Music Bingo + Wingy Wednesday',null],
    ['Reggae Brunch',null],
    ['WINE BACK WEDNESDAY - DJ LIA',null],
  ]) assert.equal(matchesEventFilter(event(title,{}, {description}),'food_drink'),true,title);
});

test('venue and performer names do not become food or drink promotions',()=>{
  const branded=event('Live Music at Example Wine Bar',{}, {venues:{name:'Example Wine Bar'},description:'Join us for a free concert in the beer garden.'});
  assert.equal(matchesEventFilter(branded,'food_drink'),false);
  const performer=event('Whiskey Smoke',{performer:{name:'Whiskey Smoke',genre:'Rock'}});
  assert.equal(matchesEventFilter(performer,'food_drink'),false);
  assert.equal(matchesEventFilter(performer,'music'),true);
  assert.equal(matchesEventFilter(event('Unknown Name',{category:'Food & Drink'}),'food_drink'),true);
  assert.equal(matchesEventFilter(event('Unknown Name',{classifications:[{segment:{name:'Food & Drink'}}]}),'food_drink'),true);
  assert.equal(matchesEventFilter(event('Unknown Name',{status:'suppressed',category:'Food & Drink'}),'food_drink'),false);
});

test('Game Night includes pub games and hybrids while excluding a plain sports game listing',()=>{
  for(const title of ['Trivia Night','Music Bingo','Board Games','Poker Night','Quiz Night','Darts Tournament','Game Night Wednesday']) {
    assert.equal(matchesEventFilter(event(title),'games'),true,title);
  }
  assert.equal(matchesEventFilter(event('NFL FOOTBALL GAMES'),'games'),false);
  assert.equal(matchesEventFilter(event('NFL FOOTBALL GAMES'),'sports'),true);
  assert.equal(matchesEventFilter(event('Football Trivia Night'),'games'),true);
  assert.equal(matchesEventFilter(event('Football Trivia Night'),'sports'),true);
});

test('the four filters share search semantics, including corroborated performer names',()=>{
  assert.deepEqual(EVENT_CATEGORY_FILTERS.map(row=>row.label),['Live Music','Game Night','Sports','Food and Drink']);
  const known=event('LIVE MUSIC: Example Artist',{performer:{name:'Example Artist',genre:'Jazz'}});
  const unknown=event('Example Artist');const catalog=buildPerformerCatalog([known,unknown]);
  assert.equal(matchesEventFilter(unknown,'music',catalog),true);
  assert.equal(matchesEventFilter(unknown,'food_drink',catalog),false);
  assert.equal(matchesEventFilter(unknown,null,catalog),true);
  assert.equal(matchesEventSearch(event('Trivia Night'),'game night'),true);
});
