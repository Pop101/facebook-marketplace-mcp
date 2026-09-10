import { z } from "zod";
import type { FacebookClient } from "../facebook/client.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const getListingImagesSchema = {
  listing_id: z.string().describe("Facebook Marketplace listing ID"),
  image_numbers: z
    .array(z.number().int().positive())
    .optional()
    .describe("1-based photo numbers to return. Omit to return the first photos."),
  max_images: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(4)
    .describe("Maximum photos to return when image_numbers is omitted (default: 4, maximum: 10)"),
};

type ToolImage = { type: "image"; data: string; mimeType: string };
type ToolText = { type: "text"; text: string };

function isFacebookImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "fbcdn.net" || url.hostname.endsWith(".fbcdn.net"))
    );
  } catch {
    return false;
  }
}

async function downloadImage(url: string): Promise<ToolImage> {
  if (!isFacebookImageUrl(url)) {
    throw new Error("Listing photo URL is not an HTTPS Facebook CDN URL.");
  }

  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status} ${response.statusText}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase();
  if (!mimeType || !SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image content type: ${mimeType ?? "missing"}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit.`);
  }

  return { type: "image", data: bytes.toString("base64"), mimeType };
}

export function createListingImagesHandler(client: FacebookClient) {
  return async (args: {
    listing_id: string;
    image_numbers?: number[];
    max_images: number;
  }) => {
    try {
      const listing = await client.getListingDetail(args.listing_id);
      const imageUrls = [...new Set(listing.images)].filter(Boolean);
      const selectedIndexes = args.image_numbers
        ? [...new Set(args.image_numbers)].filter((number) => number <= imageUrls.length)
        : imageUrls.slice(0, args.max_images).map((_, index) => index + 1);

      if (selectedIndexes.length === 0) {
        return {
          content: [{ type: "text" as const, text: "This listing has no photos matching the requested image numbers." }],
        };
      }

      const content: Array<ToolText | ToolImage> = [
        {
          type: "text",
          text: `Photos for ${listing.title || `listing ${args.listing_id}`} (photo numbers: ${selectedIndexes.join(", ")}).`,
        },
      ];
      const failures: string[] = [];

      for (const imageNumber of selectedIndexes) {
        try {
          content.push(await downloadImage(imageUrls[imageNumber - 1]));
        } catch (error) {
          failures.push(
            `Photo ${imageNumber}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (failures.length > 0) {
        content.push({ type: "text", text: `Some photos could not be returned:\n${failures.join("\n")}` });
      }

      return { content, isError: content.length === 1 };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching listing photos: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };
}
