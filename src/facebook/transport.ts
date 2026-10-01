import { execFile } from "node:child_process";

function configValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

/** Keep cookies, tokens and message bodies out of process arguments and errors. */
export function buildCurlConfig(url: string, headers: Record<string, string>, body: string): string {
  const config = [
    "silent", "show-error", "connect-timeout = 15", "max-time = 45",
    'request = "POST"', `url = ${configValue(url)}`, 'write-out = "\\n%{http_code}"',
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(name + value)) throw new Error("Invalid HTTP header.");
    if (name.toLowerCase() !== "user-agent") config.push(`header = ${configValue(`${name}: ${value}`)}`);
  }
  // The caller supplies URL-encoded form data, never an @filename expression.
  if (body.startsWith("@")) throw new Error("Invalid form body.");
  config.push(`data-binary = ${configValue(body)}`);
  return config.join("\n") + "\n";
}

export function postWithCurl(binary: string, url: string, headers: Record<string, string>, body: string): Promise<{status: number; text: string}> {
  const config = buildCurlConfig(url, headers, body);
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ["--config", "-"], {maxBuffer: 32 * 1024 * 1024, timeout: 55_000}, (error, stdout) => {
      if (error) {
        // execFile errors include the command and may contain remote stderr.
        reject(new Error(error.killed ? "Facebook transport timed out; request outcome is unknown." : "Facebook transport failed; request outcome is unknown."));
        return;
      }
      const boundary = stdout.lastIndexOf("\n");
      const status = Number(stdout.slice(boundary + 1).trim());
      if (boundary < 0 || !Number.isInteger(status) || status < 100 || status > 599) {
        reject(new Error("Facebook transport returned an invalid HTTP status."));
        return;
      }
      resolve({status, text: stdout.slice(0, boundary)});
    });
    child.stdin?.on("error", () => reject(new Error("Facebook transport input failed; request outcome is unknown.")));
    child.stdin?.end(config);
  });
}

export function parseGraphqlResponse(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, ""));
  } catch {
    throw new Error("Facebook returned an invalid GraphQL response. Raw response omitted for privacy.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Facebook returned an invalid GraphQL envelope.");
  const result = parsed as Record<string, unknown>;
  if (result.error || (Array.isArray(result.errors) && result.errors.length > 0)) {
    const code = typeof result.error === "number" ? ` (${result.error})` : "";
    throw new Error(`Facebook rejected the GraphQL request${code}. No successful result was confirmed.`);
  }
  if (!result.data || typeof result.data !== "object") throw new Error("Facebook returned no GraphQL data; this is not an empty inbox.");
  return result;
}
