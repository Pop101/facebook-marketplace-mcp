import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// Set the directory before importing storage; never touch the operator's monitors.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-monitor-test-'));
process.env.FACEBOOK_MARKETPLACE_DATA_DIR = directory;
const {createMonitorSearchHandler, createCheckMonitorsHandler, monitorSearchSchema} = await import('../dist/tools/monitor.js');
const {addMonitor, getMonitor, deleteMonitor} = await import('../dist/storage/monitors.js');
test.after(async () => { await fs.rm(directory, {recursive:true, force:true}); });
const args = {name:'synthetic',query:'Suvie',latitude:45.63,longitude:-122.60,radius_km:50};
function emptyResult(extra = {}) {
  return {listings:[],hasNextPage:true,endCursor:'next',pagesFetched:1,stopReason:'page_limit',skippedFeedUnits:0,excludedListings:0,warnings:['Partial scan; more pages remain.'],...extra};
}

test('monitor schema exposes bounded search scope without a saved cursor', () => {
  const result = z.object(monitorSearchSchema).parse(args);
  assert.equal(result.delivery_method,'local_pickup');
  assert.equal(result.max_pages,1);
  assert.equal(result.limit,24);
  assert.equal('cursor' in monitorSearchSchema,false);
});
test('new monitors persist selected delivery and page budget', async () => {
  const result = await createMonitorSearchHandler()({...args,max_pages:3,delivery_method:'shipping',limit:15});
  assert.ok(!result.isError);
  const saved = getMonitor('synthetic');
  assert.equal(saved.params.deliveryMethod,'shipping');
  assert.equal(saved.params.maxPages,3);
  assert.equal(saved.params.limit,15);
  deleteMonitor('synthetic');
});
test('monitor price validation does not save an invalid search', async () => {
  const result = await createMonitorSearchHandler()({...args,min_price:200,max_price:100});
  assert.equal(result.isError,true);
  assert.equal(getMonitor('synthetic'),undefined);
});
test('no-new-listing monitor result discloses its partial coverage and cursor', async () => {
  await createMonitorSearchHandler()(args);
  const result = await createCheckMonitorsHandler({searchListings:async()=>emptyResult()})({monitor_name:'synthetic'});
  const text = result.content[0].text;
  assert.match(text,/no new listings in the scanned pages/);
  assert.match(text,/page_limit/);
  assert.match(text,/next_cursor: "next"/);
  assert.match(text,/unverified/);
  deleteMonitor('synthetic');
});
test('monitor search failure does not advance last-checked time', async () => {
  await createMonitorSearchHandler()(args);
  const result = await createCheckMonitorsHandler({searchListings:async()=>{throw new Error('synthetic failure');}})({monitor_name:'synthetic'});
  assert.equal(result.isError,true);
  assert.equal(getMonitor('synthetic').lastChecked,null);
  deleteMonitor('synthetic');
});
test('monitor flags later-page failure instead of reporting complete success', async () => {
  await createMonitorSearchHandler()(args);
  const result = await createCheckMonitorsHandler({searchListings:async()=>emptyResult({stopReason:'page_error'})})({monitor_name:'synthetic'});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/page_error/);
  deleteMonitor('synthetic');
});
test('legacy monitors disclose their existing all-delivery scope', async () => {
  addMonitor('legacy',{query:'Suvie',latitude:45.63,longitude:-122.60,radiusKm:50,limit:24});
  let forwarded;
  const result = await createCheckMonitorsHandler({searchListings:async params=>{forwarded=params;return emptyResult();}})({monitor_name:'legacy'});
  assert.equal(forwarded.deliveryMethod,undefined);
  assert.match(result.content[0].text,/delivery requested: all/);
  deleteMonitor('legacy');
});
