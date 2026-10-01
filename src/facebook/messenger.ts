import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import path from "node:path";
import { MessengerSnapshot } from "./lightspeed.js";

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../..");
const PROFILE = process.env.FACEBOOK_MESSENGER_PROFILE ?? path.join(ROOT, ".fb-profile");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function validateFacebookId(id: string): void {
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw new Error("Facebook IDs must be positive 64-bit decimal strings.");
}

/** Use Facebook's current web client to construct GraphQL/Lightspeed requests.
 * No replayed Mercury endpoints, stored password handling, or invented doc_ids.
 */
export class MessengerBrowser {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly expectedAccount: () => Promise<string>) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async withPage<T>(route: string, action: (page: Page, state: MessengerSnapshot) => Promise<T>): Promise<T> {
    if (!existsSync(PROFILE)) throw new Error("Messenger browser profile is missing. Run the existing session refresher or set FACEBOOK_MESSENGER_PROFILE to an authenticated dedicated profile.");
    const accountId = await this.expectedAccount();
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(PROFILE, {headless: true, timeout: 15_000, args: ["--no-sandbox"]});
    } catch {
      throw new Error("Messenger browser could not start. Check Chromium installation and whether the session refresher currently owns the profile.");
    }
    try {
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(7000);
      const state = new MessengerSnapshot();
      const pending = new Set<Promise<void>>();
      page.on("websocket", socket => {
        if (!/facebook\.com\//.test(socket.url()) || !/lightspeed|\/chat\b/.test(socket.url())) return;
        socket.on("framesent", frame => state.ingestPacket(frame.payload, true));
        socket.on("framereceived", frame => state.ingestPacket(frame.payload));
      });
      page.on("response", response => {
        const request = response.request();
        if (!response.url().startsWith("https://www.facebook.com/api/graphql/")) return;
        const operation = request.headers()["x-fb-friendly-name"] ?? new URLSearchParams(request.postData() ?? "").get("fb_api_req_friendly_name") ?? "";
        if (!operation.includes("Lightspeed")) return;
        const read = response.text().then(text => {state.ingestPacket(text);}).catch(() => undefined);
        pending.add(read); void read.finally(() => pending.delete(read));
      });
      try {
        await page.goto(`https://www.facebook.com/${route}`, {waitUntil: "domcontentloaded", timeout: 30_000});
      } catch {
        throw new Error("Messenger page did not load; no operation was performed.");
      }
      state.ingestHtml(await page.content());
      if (!state.accountId || state.accountId === "0") throw new Error("Messenger browser is logged out or checkpointed. Refresh its session; no inbox result was confirmed.");
      if (state.accountId !== accountId) throw new Error("Messenger browser and Marketplace client belong to different accounts. No message was sent.");
      await Promise.race([Promise.all([...pending]), delay(5000)]);
      return await action(page, state);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async loaded(state: MessengerSnapshot, threadId?: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (threadId ? state.threads.has(threadId) && [...state.messages.values()].some(m => m.threadId === threadId) : state.marketplaceLoaded) {
        await delay(1200);
        return;
      }
      await delay(250);
    }
    // The typed accessors produce precise missing-data/encryption errors.
  }

  checkMessages(limit: number) {
    return this.exclusive(() => this.withPage("messages/", async (_page, state) => {
      await this.loaded(state);
      return state.marketplaceThreads(limit);
    }));
  }

  readThread(threadId: string, limit: number) {
    validateFacebookId(threadId);
    return this.exclusive(() => this.withPage(`messages/t/${threadId}/`, async (_page, state) => {
      await this.loaded(state, threadId);
      return state.threadMessages(threadId, limit);
    }));
  }

  private async dismissRestorePrompt(page: Page): Promise<void> {
    const dialog = page.getByRole("dialog").filter({hasText: /restore.*chat|enter your PIN/i}).last();
    if (await dialog.isVisible().catch(() => false)) {
      // Only dismiss the prompt. Never reset encrypted storage or recovery settings.
      await dialog.getByRole("button", {name: "Close", exact: true}).last().click().catch(() => undefined);
    }
  }

  sendThreadMessage(threadId: string, message: string) {
    validateFacebookId(threadId);
    return this.exclusive(() => this.withPage(`messages/t/${threadId}/`, async (page, state) => {
      await this.loaded(state, threadId);
      state.threadMessages(threadId, 1); // Reject missing/E2EE threads before entering text.
      await this.dismissRestorePrompt(page);
      const composer = page.locator('[role="textbox"][contenteditable="true"]');
      if (await composer.count() !== 1) throw new Error("Messenger composer was not uniquely identified. Nothing was sent.");
      let attempted = false;
      try {
        await composer.fill(message);
        state.outgoing.length = 0;
        state.acknowledgements.clear();
        const started = Date.now();
        attempted = true;
        await composer.press("Enter");
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const receipt = state.receipt(threadId, message, started);
          if (receipt) return receipt;
          await delay(200);
        }
      } catch {
        throw new Error(attempted ? "Send outcome is unknown. Inspect the thread before retrying; automatic retries can duplicate messages." : "Message could not be entered. Nothing was sent.");
      }
      throw new Error("Facebook did not acknowledge this specific message. Inspect the thread before retrying; do not automatically resend.");
    }));
  }

  startSellerThread(listingId: string, sellerId: string, message: string) {
    validateFacebookId(listingId); validateFacebookId(sellerId);
    return this.exclusive(() => this.withPage(`marketplace/item/${listingId}/`, async (page, state) => {
      const composer = page.getByRole("textbox", {name: /message/i});
      await composer.first().waitFor({state: "visible", timeout: 7000}).catch(() => undefined);
      if (await page.getByRole("button", {name: "Message again", exact: true}).count()) throw new Error("A conversation already exists for this listing. Use check_messages and send_thread_message instead; nothing was sent.");
      if (await composer.count() !== 1) throw new Error("Listing message composer was not uniquely identified. Nothing was sent.");
      const send = page.getByRole("button", {name: "Send", exact: true});
      if (await send.count() !== 1) throw new Error("Listing Send button was not uniquely identified. Nothing was sent.");
      let attempted = false;
      try {
        await composer.fill(message);
        const started = Date.now();
        attempted = true;
        await send.click();
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          // Initial contact may use a Marketplace GraphQL mutation rather than task 46.
          // Require a real server message in a Marketplace thread with this seller.
          const confirmed = [...state.messages.values()].find(m => m.senderId === state.accountId && m.text === message && Number(m.sentAt) >= started && state.threads.get(m.threadId)?.parentId === "-12" && state.participants.get(m.threadId)?.has(sellerId));
          if (confirmed) return {threadId: confirmed.threadId, messageId: confirmed.id};
          await delay(200);
        }
      } catch {
        throw new Error(attempted ? "First-message outcome is unknown. Check the listing conversation before retrying." : "Message could not be entered. Nothing was sent.");
      }
      throw new Error("Facebook did not confirm the first seller message. Inspect Messenger before retrying.");
    }));
  }
}
