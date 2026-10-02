import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createSearchHandler, searchListingsSchema } from '../dist/tools/search.js';

const args = {query:'Suvie',latitude:45.63,longitude:-122.60};
test('structured pagination survives a real MCP tools/call round trip', async () => {
  const server = new McpServer({name:'synthetic-search',version:'1.0.0'});
  server.tool('search_listings','Synthetic read-only search',searchListingsSchema,createSearchHandler({searchListings:async()=>({
    listings:[],hasNextPage:true,endCursor:'opaque-next',pagesFetched:1,stopReason:'page_limit',skippedFeedUnits:0,excludedListings:0,warnings:['Partial scan'],
  })}));
  const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name:'synthetic-client',version:'1.0.0'});
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({name:'search_listings',arguments:args});
    assert.equal(result.structuredContent.next_cursor,'opaque-next');
    assert.equal(result.structuredContent.stop_reason,'page_limit');
    assert.equal(result.isError,false);
  } finally {
    await client.close();
    await server.close();
  }
});
test('actual entry point advertises continuation fields and search instructions', async () => {
  const root = fileURLToPath(new URL('../',import.meta.url));
  const transport = new StdioClientTransport({command:process.execPath,args:['dist/index.js'],cwd:root,env:{PATH:process.env.PATH ?? ''},stderr:'pipe'});
  const client = new Client({name:'schema-smoke',version:'1.0.0'});
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const schema = tools.tools.find(tool=>tool.name==='search_listings').inputSchema.properties;
    for (const field of ['cursor','max_pages','delivery_method']) assert.ok(schema[field]);
    assert.match(client.getInstructions(),/model-specific/);
    assert.match(client.getInstructions(),/incomplete coverage/);
  } finally { await client.close(); }
});
