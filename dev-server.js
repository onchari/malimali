const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

http
  .createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }

    if (pathname === "/") pathname = "/index.html";
    const filePath = path.resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, content) => {
      if (error) {
        response
          .writeHead(error.code === "ENOENT" ? 404 : 500)
          .end(error.code === "ENOENT" ? "Not found" : "Unable to read file");
        return;
      }

      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type":
          contentTypes[path.extname(filePath).toLowerCase()] ||
          "application/octet-stream",
      });
      response.end(content);
    });
  })
  .listen(8765, "127.0.0.1", () => {
    console.log(`Development server running at http://127.0.0.1:8765/`);
  });
