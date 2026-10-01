#!/usr/bin/env tsx
/**
 * Keeps the Facebook session alive for the MCP server.
 *
 * Runs headless Chromium with a persistent profile (.fb-profile/). On each run:
 *   1. Open facebook.com — a live session sets/refreshes the auth cookies.
 *   2. If logged out, re-login with FB_EMAIL/FB_PASSWORD (+ FB_TOTP_SECRET for 2FA).
 *   3. Write the current cookies into facebook-marketplace-mcp.env and restart
 *      the service when they changed.
 *
 * Env file paths are relative to the repo root (parent of scripts/).
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, ".fb-profile");
const ENV_FILE = path.join(ROOT, "facebook-marketplace-mcp.env");
const LOGIN_FILE = path.join(ROOT, "fb-login.env");
const DEBUG_SHOT = "/tmp/fb-refresh-debug.png";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// Cookie names the MCP server needs (rest are harmless to include)
const WANTED = [
  "c_user", "xs", "datr", "sb", "fr", "wd", "locale", "presence", "oo", "m_pixel_ratio",
];

function readLoginEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(LOGIN_FILE)) return out;
  for (const line of fs.readFileSync(LOGIN_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function totp(secret: string): string {
  const key = Buffer.from(secret.replace(/\s+/g, "").toUpperCase(), "base32" as any);
  const counter = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

function currentHeader(): string {
  if (!fs.existsSync(ENV_FILE)) return "";
  const m = fs.readFileSync(ENV_FILE, "utf8").match(/^FACEBOOK_COOKIE_HEADER="([^"]*)"/m);
  return m ? m[1] : "";
}

function writeHeader(header: string): void {
  const rest = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => !l.startsWith("FACEBOOK_COOKIE_HEADER="))
    : [];
  fs.writeFileSync(ENV_FILE, `FACEBOOK_COOKIE_HEADER="${header}"\n` + rest.join("\n"), { mode: 0o600 });
}

async function main() {
  const creds = readLoginEnv();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    userAgent: UA,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    console.log("Opening facebook.com ...");
    await page.goto("https://www.facebook.com/marketplace/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(5000);

    let cookies = await context.cookies("https://www.facebook.com");
    let loggedIn = cookies.some((c) => c.name === "c_user");

    if (!loggedIn) {
      // Second chance: a freshly pasted cookie header in the env file can
      // bootstrap the persistent profile without a password login (and thus
      // without hitting the reCAPTCHA wall Facebook puts on headless logins).
      const envHeader = currentHeader();
      if (envHeader.includes("c_user=") && envHeader.includes("xs=")) {
        console.log("Injecting cookie header from env file into browser profile...");
        const toAdd = envHeader.split(";").map((part) => {
          const [name, ...rest] = part.trim().split("=");
          return { name, value: rest.join("="), domain: ".facebook.com", path: "/" };
        });
        await context.addCookies(toAdd);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(5000);
        cookies = await context.cookies("https://www.facebook.com");
        loggedIn = cookies.some((c) => c.name === "c_user");
        if (loggedIn) {
          // Verify the session actually works, not just that cookies exist
          const probe = await page.evaluate(async () => {
            const r = await fetch("https://www.facebook.com/marketplace/", { credentials: "include" });
            return r.status === 200;
          });
          if (!probe) loggedIn = false;
        }
        if (loggedIn) console.log("Session bootstrapped from pasted cookies.");
      }
    }

    if (!loggedIn) {
      console.log("Not logged in — attempting credential login.");
      if (!creds.FB_EMAIL || !creds.FB_PASSWORD) {
        await page.screenshot({ path: DEBUG_SHOT });
        throw new Error(
          `Logged out and no credentials in ${LOGIN_FILE} (need FB_EMAIL/FB_PASSWORD, optional FB_TOTP_SECRET). Screenshot: ${DEBUG_SHOT}`
        );
      }
      await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
      const emailInput = page.locator('input[name="email"], input[type="email"], input[placeholder*="mail"]').first();
      const passInput = page.locator('input[name="pass"], input[type="password"]').first();
      await emailInput.fill(creds.FB_EMAIL);
      await passInput.fill(creds.FB_PASSWORD);
      await page.locator('input[type="submit"], [role="button"]:has-text("Log in"), button:has-text("Log in")').first().click();
      await page.waitForTimeout(8000);

      // 2FA / checkpoint handling
      if (/two_factor|checkpoint/i.test(page.url())) {
        if (creds.FB_TOTP_SECRET) {
          const code = totp(creds.FB_TOTP_SECRET);
          const otp = page.locator('input[name="approvals_code"], input[type="text"]').first();
          await otp.fill(code);
          await page.locator('button[type="submit"], #checkpointSubmitButton').first().click();
          await page.waitForTimeout(6000);
          // "Trust this device" prompts
          const trust = page.locator('button:has-text("Trust"), #checkpointSubmitButton').first();
          if (await trust.isVisible().catch(() => false)) await trust.click().catch(() => {});
          await page.waitForTimeout(5000);
        } else {
          await page.screenshot({ path: DEBUG_SHOT });
          throw new Error(`2FA/checkpoint hit and no FB_TOTP_SECRET set. URL: ${page.url()} — screenshot: ${DEBUG_SHOT}`);
        }
      }

      await page.goto("https://www.facebook.com/marketplace/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(5000);
      cookies = await context.cookies("https://www.facebook.com");
      loggedIn = cookies.some((c) => c.name === "c_user");
      if (!loggedIn) {
        await page.screenshot({ path: DEBUG_SHOT });
        throw new Error(
          `Credential login failed (Facebook likely walled it with a reCAPTCHA image challenge, which cannot be automated). URL: ${page.url()} — screenshot: ${DEBUG_SHOT}. Recovery: paste a fresh Cookie header into ${ENV_FILE} and rerun; the refresher bootstraps the profile from it without a password login.`
        );
      }
      console.log("Logged in via credentials.");
    }

    // Linger a little so activity-based rotation/keepalive kicks in
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(5000);
    cookies = await context.cookies("https://www.facebook.com");

    const picked = WANTED.map((name) => cookies.find((c) => c.name === name)).filter(Boolean) as { name: string; value: string }[];
    const xs = picked.find((c) => c.name === "xs");
    if (!xs) throw new Error("Logged in but no xs cookie found — unexpected.");
    const header = picked.map((c) => `${c.name}=${c.value}`).join("; ");

    if (header === currentHeader()) {
      console.log("Cookies unchanged; no restart needed.");
    } else {
      writeHeader(header);
      execFileSync("sudo", ["-n", "systemctl", "restart", "facebook-marketplace-mcp"], { stdio: "inherit" });
      console.log("Cookies refreshed; service restarted.");
    }
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error("REFRESH FAILED:", e.message);
  process.exit(1);
});
