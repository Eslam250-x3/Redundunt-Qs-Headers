import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDataDir = path.resolve(__dirname, "../data");
const reviewOutputDir = path.resolve(packageDataDir, "output");
const reviewOriginalPackagesDir = path.resolve(
  packageDataDir,
  "output/original-packages",
);

function createStaticMiddleware(prefix, rootDir) {
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;

  return (req, res, next) => {
    if (!req.url) {
      next();
      return;
    }

    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (
      urlPath !== normalizedPrefix &&
      !urlPath.startsWith(`${normalizedPrefix}/`)
    ) {
      next();
      return;
    }

    const requestPath = urlPath.slice(normalizedPrefix.length);
    const normalizedPath = requestPath.replace(/^\/+/, "");
    const filePath = path.resolve(rootDir, normalizedPath);

    if (!filePath.startsWith(rootDir)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      next();
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".json": "application/json; charset=utf-8",
      ".zip": "application/zip",
      ".csv": "text/csv; charset=utf-8",
    };

    res.setHeader(
      "Content-Type",
      contentTypes[extension] || "application/octet-stream",
    );
    fs.createReadStream(filePath).pipe(res);
  };
}

function serveReviewAssets() {
  return {
    name: "redundant-review-static",
    configureServer(server) {
      server.middlewares.use(
        createStaticMiddleware("/redundant-review", reviewOutputDir),
      );
      server.middlewares.use(
        createStaticMiddleware(
          "/redundant-review-original",
          reviewOriginalPackagesDir,
        ),
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), serveReviewAssets()],
  base: "./",
  server: {
    port: 4000,
  },
});
