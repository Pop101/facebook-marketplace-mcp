#!/usr/bin/env tsx
/**
 * Headless capture of the Marketplace search pagination GraphQL query.
 * Loads /marketplace/search/?query=..., scrolls to trigger pagination,
 * and records doc_ids whose requests or responses mention marketplace search.
 */

import { chromium } from "playwright";
import fs from "node:fs";

const cookieHeader = process.env.FACEBOOK_COOKIE_HEADER?.trim();
if (!cookieHeader) {
  console.error("Set FACEBOOK_COOKIE_HEADER first.");
  process.exit(1);
}

const cookies = cookieHeader.split(";").map((part) => {
  const [name, ...rest] = part.trim().split("=");
  return { name, value: rest.join("="), domain: ".facebook.com", path: "/" };
});

interface Hit {
  docId: string;
  variables: string;
  hasMarketplaceSearch: boolean;
  hasListingTitle: boolean;
}

async function main() {
  const hits: Hit[] = [];

  const context = await chromium.launchPersistentContext("/tmp/fb-capture-profile", {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  await context.addCookies(cookies);
  const page = context.pages()[0] ?? (await context.newPage());

  page.on("response", async (res) => {
    if (!res.url().includes("/api/graphql")) return;
    try {
      const body = await res.text();
      const hasMkt = body.includes("marketplace_search");
      const hasTitle = body.includes("marketplace_listing_title");
      if (!hasMkt && !hasTitle) return;
      const params = new URLSearchParams(res.request().postData() ?? "");
      const docIds = params.getAll("doc_id");
      const variables = params.get("variables") ?? "{}";
      for (const docId of docIds) {
        if (!docId) continue;
        hits.push({ docId, variables, hasMarketplaceSearch: hasMkt, hasListingTitle: hasTitle });
        console.log(`🎯 doc_id=${docId} marketplace_search=${hasMkt} listing_title=${hasTitle}`);
      }
    } catch {
      // streaming/binary responses: ignore
    }
  });

  console.log("Loading marketplace search page...");
  await page.goto("https://www.facebook.com/marketplace/search/?query=couch", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(6000);

  for (let i = 0; i < 6; i++) {
    console.log(`scroll ${i + 1}`);
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(3500);
  }

  await context.close();

  const unique = new Map<string, Hit>();
  for (const h of hits) if (!unique.has(h.docId)) unique.set(h.docId, h);
  console.log("\n=== Hits ===");
  for (const h of unique.values()) {
    console.log(`\ndoc_id: ${h.docId} (marketplace_search=${h.hasMarketplaceSearch}, listing_title=${h.hasListingTitle})`);
    console.log(`variables: ${h.variables.slice(0, 500)}`);
  }
  fs.writeFileSync("/tmp/captured-pagination.json", JSON.stringify([...unique.values()], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
