#!/usr/bin/env tsx
/**
 * Headless query capture for a Linux server (no Chrome profile).
 * Injects FACEBOOK_COOKIE_HEADER into a headless Chromium context,
 * performs a Marketplace search, and records every GraphQL doc_id seen.
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
  return {
    name,
    value: rest.join("="),
    domain: ".facebook.com",
    path: "/",
  };
});

interface CapturedQuery {
  docId: string;
  operationName: string;
  variables: string;
}

async function main() {
  const captured: CapturedQuery[] = [];

  const context = await chromium.launchPersistentContext("/tmp/fb-capture-profile", {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  await context.addCookies(cookies);

  const page = context.pages()[0] ?? (await context.newPage());

  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/graphql")) {
      const params = new URLSearchParams(req.postData() ?? "");
      const docIds = params.getAll("doc_id");
      const variables = params.get("variables") ?? "{}";
      for (const docId of docIds) {
        if (!docId) continue;
        let opName = "unknown";
        try {
          const vars = JSON.parse(variables);
          if (vars.params?.bqf?.callsite === "COMMERCE_MKTPLACE_WWW") {
            opName = "marketplace_search";
          } else if (vars.params?.caller === "MARKETPLACE") {
            opName = "city_street_search";
          } else if (vars.targetId || vars.listingID || vars.listingId) {
            opName = "listing_detail";
          }
        } catch {
          // ignore
        }
        captured.push({ docId, operationName: opName, variables: variables.slice(0, 300) });
        console.log(`📡 doc_id=${docId} op=${opName}`);
      }
    }
  });

  console.log("Navigating to Marketplace...");
  await page.goto("https://www.facebook.com/marketplace/", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(5000);

  // Detect login wall
  const body = await page.content();
  if (body.includes("Log into Facebook") || body.includes("login_form")) {
    console.log("⚠️ Login wall detected — session not accepted by headless browser.");
  }

  console.log("Performing marketplace search via direct search URL...");
  await page.goto("https://www.facebook.com/marketplace/search/?query=laptop", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(8000);
  console.log("Search page URL:", page.url());

  await context.close();

  const unique = new Map<string, CapturedQuery>();
  for (const q of captured) {
    if (!unique.has(q.docId)) unique.set(q.docId, q);
  }
  console.log("\n=== Unique doc_ids ===");
  for (const q of unique.values()) {
    console.log(`${q.docId}  ${q.operationName}`);
  }
  fs.writeFileSync("/tmp/captured-queries.json", JSON.stringify([...unique.values()], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
