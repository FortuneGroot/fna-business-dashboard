/**
 * Preload for Node test runner: resolve `server-only` to its empty stub file.
 * Next.js build still uses the throwing client entry for Client Components.
 */
const Module = require("module");
const path = require("path");
const emptyPath = path.join(__dirname, "..", "node_modules", "server-only", "empty.js");
const original = Module._resolveFilename;
Module._resolveFilename = function resolveServerOnly(request, parent, isMain, options) {
  if (request === "server-only") {
    return emptyPath;
  }
  return original.call(this, request, parent, isMain, options);
};
