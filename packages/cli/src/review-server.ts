/**
 * Local review server (plan: "relay-driver review PATH").
 *
 * Extracted from main.ts so the viewer test can start the real server
 * against a fixture package without the blocking serve-until-interrupted
 * shell. Playback works after the remote environment is gone; no external
 * services are contacted.
 */
import { createServer } from "node:http";
import { createReadStream, stat } from "node:fs";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";

const statAsync = promisify(stat);

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".mp4": "video/mp4", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".jsonl": "application/jsonl",
};

export interface ReviewServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Serve the viewer from `viewerRoot` and package files from `packageDir`
 * on 127.0.0.1 with an ephemeral port.
 */
export async function startReviewServer(
  packageDir: string,
  viewerRoot: string,
): Promise<ReviewServer> {
  const root = normalize(packageDir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(url.pathname).replace(/^\//, "");
      if (rel === "") rel = "index.html";
      // Serve /viewer assets from the viewer root, package files from the package.
      const isViewer = rel.startsWith("viewer/") || rel === "index.html";
      const filePath = isViewer
        ? join(viewerRoot, rel === "index.html" ? "index.html" : rel.slice("viewer/".length))
        : join(root, rel);
      const resolved = normalize(filePath);
      if (!resolved.startsWith(normalize(root)) && !resolved.startsWith(normalize(viewerRoot))) {
        res.writeHead(403); res.end(); return;
      }
      const st = await statAsync(resolved).catch(() => null);
      if (!st?.isFile()) { res.writeHead(404); res.end(); return; }
      const type = MIME[extname(resolved)] ?? "application/octet-stream";
      // Range support is required for mp4 seeking in Chromium (REVIEW-01:
      // the reviewer seeks to a step's media time).
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          const start = m[1] === "" ? 0 : Number(m[1]);
          const end = m[2] === "" ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
          if (start > end || start >= st.size) {
            res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            "Content-Type": type,
            "Content-Range": `bytes ${start}-${end}/${st.size}`,
            "Content-Length": end - start + 1,
            "Accept-Ranges": "bytes",
          });
          createReadStream(resolved, { start, end }).pipe(res);
          return;
        }
      }
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
      createReadStream(resolved).pipe(res);
    } catch {
      res.writeHead(500); res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
