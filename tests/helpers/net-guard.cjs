// NET-1: preloaded into the app under test (NODE_OPTIONS=--require). Every outbound TCP/TLS
// connection that is not to the local machine is refused and recorded in NET_GUARD_LOG, so the
// stack suite can prove the app sent nothing externally (no email, SMS, provider, or telemetry call).
"use strict";
const fs = require("node:fs");
const net = require("node:net");

const LOG = process.env.NET_GUARD_LOG;
const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const original = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  let host;
  let port;
  let path;
  if (opts && typeof opts === "object") {
    host = opts.host;
    port = opts.port;
    path = opts.path;
  } else if (typeof opts === "number" || (typeof opts === "string" && /^\d+$/.test(opts))) {
    port = opts;
    host = typeof args[1] === "string" ? args[1] : undefined;
  } else if (typeof opts === "string") {
    path = opts;
  }
  const target = host || "localhost";
  if (!path && !LOCAL.has(target)) {
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ host: target, port: port ?? null, at: new Date().toISOString() })}\n`);
    const socket = this;
    process.nextTick(() => socket.destroy(new Error(`NET-1: outbound connection to ${target}:${port} refused`)));
    return socket;
  }
  return original.apply(this, args);
};
