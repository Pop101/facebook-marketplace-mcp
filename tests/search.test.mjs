import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { FacebookClient } from '../dist/facebook/client.js';
import { buildSearchVariables } from '../dist/facebook/queries.js';
import { parseSearchResponse } from '../dist/facebook/parser.js';
import { createSearchHandler, searchListingsSchema } from '../dist/tools/search.js';

const params = {query: 'Suvie', latitude: 45.63, longitude: -122.60, radiusKm: 50, limit: 20};
const args = {query: 'Suvie', latitude: 45.63, longitude: -122.60, radius_km: 50, limit: 20};
function listing(id, extra = {}) {
  return {id, marketplace_listing_title: `Synthetic Suvie ${id}`, listing_price: {formatted_amount: '$140'}, delivery_types: ['IN_PERSON'], ...extra};
}
function page(items = [], hasNext = false, cursor = null) {
  return {data: {marketplace_search: {feed_units: {edges: items.map(item => ({node: {listing: item}})), page_info: {has_next_page: hasNext, end_cursor: cursor}}}}};
}
function clientFor(responses) {
  const client = new FacebookClient();
  const calls = [];
  client.graphqlRequest = async (_doc, variables) => {
    calls.push(variables);
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected extra page request');
    return response;
  };
  return {client, calls};
}

for (const [method, pickup, shipping] of [['local_pickup', true, false], ['shipping', false, true], ['all', true, true]]) {
  test(`delivery scope ${method} is sent to Facebook`, () => {
    const browse = buildSearchVariables({...params, deliveryMethod: method}).params.browse_request_params;
    assert.equal(browse.commerce_enable_local_pickup, pickup);
    assert.equal(browse.commerce_enable_shipping, shipping);
  });
}
test('zero-dollar maximum is preserved instead of becoming unlimited', () => {
  const browse = buildSearchVariables({...params, maxPrice: 0}).params.browse_request_params;
  assert.equal(browse.filter_price_upper_bound, 0);
});
test('an opaque cursor and category pass through unchanged', () => {
  const cursor = '{"pg":1,"opaque":"a/b+c="}';
  const v = buildSearchVariables({...params, cursor, category: '123'});
  assert.equal(v.cursor, cursor);
  assert.deepEqual(v.params.browse_request_params.commerce_search_and_rp_category_id, ['123']);
});
test('verified empty feed is different from malformed data', () => {
  const result = parseSearchResponse(page());
  assert.deepEqual(result.listings, []);
  assert.equal(result.hasNextPage, false);
  for (const data of [null, {}, {data:{}}, {data:{marketplace_search:null}}, {data:{marketplace_search:{feed_units:{}}}}]) {
    assert.throws(() => parseSearchResponse(data), /search response/i);
  }
});
test('malformed edges and missing pagination fail explicitly', () => {
  for (const feed of [
    {edges:null,page_info:{has_next_page:false,end_cursor:null}},
    {edges:[],page_info:{}},
    {edges:[],page_info:{has_next_page:'false',end_cursor:null}},
    {edges:[],page_info:{has_next_page:true,end_cursor:null}},
    {edges:[],page_info:{has_next_page:true,end_cursor:''}},
  ]) assert.throws(() => parseSearchResponse({data:{marketplace_search:{feed_units:feed}}}), /search response/i);
});
test('a malformed listing never silently turns the entire page into zero results', () => {
  assert.throws(() => parseSearchResponse(page([{marketplace_listing_title:'missing id'}])), /search response/i);
  assert.throws(() => parseSearchResponse(page([{id:'101'}])), /search response/i);
});
test('parser errors do not expose raw payload data', () => {
  assert.throws(() => parseSearchResponse(page([{id:{private:'synthetic-secret'}, marketplace_listing_title:'x'}])), e => !e.message.includes('synthetic-secret'));
});
test('non-listing feed units are counted, not silently lost', () => {
  const data = page([listing('101')]);
  data.data.marketplace_search.feed_units.edges.push({node:{__typename:'MarketplaceRecommendation'}});
  const result = parseSearchResponse(data);
  assert.equal(result.listings.length, 1);
  assert.equal(result.skippedFeedUnits, 1);
});
test('listing dates, delivery options, status and exact string IDs survive parsing', () => {
  const item = parseSearchResponse(page([listing('9223372036854775807', {creation_time:1700000000,is_pending:true,is_sold:false})])).listings[0];
  assert.equal(item.id, '9223372036854775807');
  assert.equal(item.postedDate, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(item.deliveryTypes, ['IN_PERSON']);
  assert.equal(item.isPending, true);
  assert.equal(item.isSold, false);
});
test('missing dates and unknown delivery are not invented', () => {
  const item = parseSearchResponse(page([listing('101', {creation_time:null,delivery_types:null})])).listings[0];
  assert.equal(item.postedDate, '');
  assert.equal(item.deliveryTypes, undefined);
});
test('an invalid optional date does not hide an otherwise valid listing', () => {
  const item = parseSearchResponse(page([listing('101', {creation_time:1e100})])).listings[0];
  assert.equal(item.postedDate, '');
});
test('a cheaper listing on page two is retrieved and duplicates are removed', async () => {
  const {client, calls} = clientFor([page([listing('101')],true,'page2'),page([listing('101'),listing('102')])]);
  const result = await client.searchListings({...params,maxPages:2});
  assert.deepEqual(result.listings.map(x=>x.id), ['101','102']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, 'page2');
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.hasNextPage, false);
  assert.equal(result.endCursor, null);
});
test('default one-page search exposes resumable partial coverage', async () => {
  const {client,calls} = clientFor([page([listing('101')],true,'page2')]);
  const result = await client.searchListings(params);
  assert.equal(calls.length,1);
  assert.equal(result.endCursor,'page2');
  assert.equal(result.stopReason,'page_limit');
  assert.ok(result.warnings.length);
});
test('page budget is enforced and continuation starts at the supplied cursor', async () => {
  const {client,calls} = clientFor([page([listing('102')],true,'page3')]);
  const result = await client.searchListings({...params,cursor:'page2',maxPages:1});
  assert.equal(calls[0].cursor,'page2');
  assert.equal(result.endCursor,'page3');
  assert.equal(result.stopReason,'page_limit');
});
test('a repeated cursor stops without an unbounded request loop', async () => {
  const {client,calls} = clientFor([page([listing('101')],true,'same'),page([listing('102')],true,'same')]);
  const result = await client.searchListings({...params,maxPages:5});
  assert.equal(calls.length,2);
  assert.equal(result.stopReason,'cursor_repeated');
  assert.equal(result.hasNextPage,true);
  assert.equal(result.endCursor,null);
});
test('a cursor cycle back to the caller-provided cursor is detected', async () => {
  const {client,calls} = clientFor([page([listing('101')],true,'b'),page([listing('102')],true,'a')]);
  const result = await client.searchListings({...params,cursor:'a',maxPages:5});
  assert.equal(calls.length,2);
  assert.equal(result.stopReason,'cursor_repeated');
});
test('empty and duplicate-only pages with advancing cursors do not imply exhaustion', async () => {
  const {client} = clientFor([page([listing('101')],true,'b'),page([],true,'c'),page([listing('101')],true,'d'),page([listing('102')])]);
  const result = await client.searchListings({...params,maxPages:4});
  assert.deepEqual(result.listings.map(x=>x.id),['101','102']);
  assert.equal(result.pagesFetched,4);
});
test('Facebook over-delivery does not lose listings behind an advanced cursor', async () => {
  const {client} = clientFor([page([listing('101'),listing('102'),listing('103')],true,'b')]);
  const result = await client.searchListings({...params,limit:1});
  assert.equal(result.listings.length,3);
  assert.equal(result.endCursor,'b');
});
test('a first-page failure is an error, not a successful empty search', async () => {
  const {client} = clientFor([new Error('synthetic transport failure')]);
  await assert.rejects(client.searchListings(params),/transport failure/);
});
test('a later-page failure preserves earlier listings and the retry cursor', async () => {
  const {client} = clientFor([page([listing('101')],true,'retry-page2'),new Error('synthetic-secret')]);
  const result = await client.searchListings({...params,maxPages:2});
  assert.deepEqual(result.listings.map(x=>x.id),['101']);
  assert.equal(result.pagesFetched,1);
  assert.equal(result.stopReason,'page_error');
  assert.equal(result.endCursor,'retry-page2');
  assert.equal(result.hasNextPage,true);
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
});
test('local pickup excludes explicitly shipping-only listings without inventing unknown delivery', async () => {
  const {client} = clientFor([page([listing('101'),listing('102',{delivery_types:['SHIPPING']}),listing('103',{delivery_types:null})])]);
  const result = await client.searchListings({...params,deliveryMethod:'local_pickup'});
  assert.deepEqual(result.listings.map(x=>x.id),['101','103']);
  assert.equal(result.excludedListings,1);
});
test('direct client validates page bounds before any Facebook request', async () => {
  const {client,calls} = clientFor([]);
  for (const invalid of [{maxPages:0},{maxPages:6},{maxPages:1.5},{limit:0},{limit:101}]) {
    await assert.rejects(client.searchListings({...params,...invalid}));
  }
  assert.equal(calls.length,0);
});
test('tool schema validates pagination and defaults to pickup scope', () => {
  const schema = z.object(searchListingsSchema);
  const result = schema.parse(args);
  assert.equal(result.delivery_method,'local_pickup');
  assert.equal(result.max_pages,1);
  assert.equal(schema.parse({...args,cursor:'opaque'}).cursor,'opaque');
  for (const invalid of [{max_pages:6},{max_pages:0},{limit:101},{latitude:91},{longitude:181},{radius_km:0},{min_price:-1},{cursor:''},{delivery_method:'teleport'}]) {
    assert.equal(schema.safeParse({...args,...invalid}).success,false);
  }
});
test('tool forwards pagination/scope and returns metadata in structured and text output', async () => {
  const {client,calls} = clientFor([page([listing('101',{creation_time:1700000000})],true,'opaque-next')]);
  const result = await createSearchHandler(client)({...args,cursor:'opaque-in',max_pages:1,delivery_method:'local_pickup'});
  assert.equal(calls[0].cursor,'opaque-in');
  assert.equal(calls[0].params.browse_request_params.commerce_enable_shipping,false);
  assert.equal(result.structuredContent.next_cursor,'opaque-next');
  assert.equal(result.structuredContent.has_next_page,true);
  assert.equal(result.structuredContent.pages_fetched,1);
  assert.equal(result.structuredContent.stop_reason,'page_limit');
  assert.equal(result.structuredContent.location_verification,'unverified');
  assert.equal(result.structuredContent.listings[0].posted_at,'2023-11-14T22:13:20.000Z');
  const text = result.content.map(x=>x.text).join('\n');
  assert.match(text,/opaque-next/);
  assert.match(text,/unverified/i);
});
test('empty partial pages retain pagination instead of claiming there are no matches', async () => {
  const {client} = clientFor([page([],true,'next')]);
  const result = await createSearchHandler(client)(args);
  assert.equal(result.structuredContent.next_cursor,'next');
  assert.ok(!result.content[0].text.includes('No listings found'));
});
test('inverted price filters are rejected without a Facebook request', async () => {
  const {client,calls} = clientFor([]);
  const result = await createSearchHandler(client)({...args,min_price:200,max_price:100});
  assert.equal(result.isError,true);
  assert.equal(calls.length,0);
});
test('tool flags a later-page failure while preserving structured partial data', async () => {
  const {client} = clientFor([page([listing('101')],true,'next'),new Error('synthetic failure')]);
  const result = await createSearchHandler(client)({...args,max_pages:2});
  assert.equal(result.isError,true);
  assert.equal(result.structuredContent.listings.length,1);
  assert.equal(result.structuredContent.stop_reason,'page_error');
});
test('malformed first page becomes a tool error, never zero matches', async () => {
  const {client} = clientFor([{data:{unrelated:true}}]);
  const result = await createSearchHandler(client)(args);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/search response/i);
});

test('pickup filtering does not discard door pickup or unfamiliar delivery values', async () => {
  const {client} = clientFor([page([
    listing('101',{delivery_types:['DOOR_PICKUP']}),
    listing('102',{delivery_types:['FUTURE_DELIVERY_TYPE']}),
    listing('103',{delivery_types:['SHIPPING','IN_PERSON']}),
    listing('104',{delivery_types:['SHIPPING']}),
  ])]);
  const result = await client.searchListings({...params,deliveryMethod:'local_pickup'});
  assert.deepEqual(result.listings.map(x=>x.id),['101','102','103']);
  assert.equal(result.excludedListings,1);
});
