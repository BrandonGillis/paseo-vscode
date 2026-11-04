import { spawnProcess } from "@getpaseo/plugin/server";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import net from "node:net";

/*
 * Unix sockets carried over one `docker exec` into a dev container, like VS Code's Dev
 * Containers: nothing is mounted into the container and nothing listens on a network port.
 *
 * One small Node script runs in the container (as the remote user) and talks to the plugin
 * over its stdin/stdout, which carry many connections at once:
 *   - forward: a socket the plugin listens on here; each connection is opened in the
 *     container to `target` (code-server's socket).
 *   - reverse: a socket the script listens on in the container (`listen`); each connection
 *     is opened here to `hostTarget` (the Paseo Bridge server).
 *
 * Frames: type (1 byte), connection id (uint32), payload length (uint32), payload.
 * Ids opened by the plugin are even, by the container odd.
 */

const OPEN = 1;
const DATA = 2;
const END = 3;
const CLOSE = 4;
const READY = 5;

// The same framing on both sides; kept free of anything not in plain Node.
const COMMON = String.raw`
function frames(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 9) {
      const len = buf.readUInt32BE(5);
      if (buf.length < 9 + len) break;
      const type = buf[0], id = buf.readUInt32BE(1), payload = buf.subarray(9, 9 + len);
      buf = buf.subarray(9 + len);
      onFrame(type, id, payload);
    }
  };
}
function frame(type, id, payload) {
  const head = Buffer.alloc(9);
  head[0] = type;
  head.writeUInt32BE(id, 1);
  head.writeUInt32BE(payload ? payload.length : 0, 5);
  return payload ? Buffer.concat([head, payload]) : head;
}
function link(socks, send, id, sock) {
  socks.set(id, sock);
  sock.on("data", (d) => send(frame(${DATA}, id, d)));
  sock.on("end", () => { if (socks.get(id) === sock) send(frame(${END}, id)); });
  sock.on("close", () => { if (socks.get(id) === sock) { socks.delete(id); send(frame(${CLOSE}, id)); } });
  sock.on("error", () => {});
}
function onPeerFrame(socks, type, id, payload) {
  const sock = socks.get(id);
  if (!sock) return;
  if (type === ${DATA}) sock.write(payload);
  else if (type === ${END}) sock.end();
  else if (type === ${CLOSE}) { socks.delete(id); sock.destroy(); }
}
`;

/** Runs in the container: `node -e RELAY_SCRIPT <target> <listen>`. */
const CONTAINER_SCRIPT = String.raw`"use strict";
const net = require("net"), fs = require("fs");
${COMMON}
const [target, listen] = process.argv.slice(1);
const socks = new Map();
const send = (b) => process.stdout.write(b);
let next = 1;
process.stdin.on("data", frames((type, id, payload) => {
  if (type === ${OPEN}) link(socks, send, id, net.connect(target));
  else onPeerFrame(socks, type, id, payload);
}));
// The plugin went away: so does everything relayed.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
try { fs.unlinkSync(listen); } catch {}
const server = net.createServer((sock) => { const id = next; next += 2; send(frame(${OPEN}, id)); link(socks, send, id, sock); });
server.listen(listen, () => { try { fs.chmodSync(listen, 0o600); } catch {} send(frame(${READY}, 0)); });
`;

// The host half, compiled from the same source.
const HOST = new Function(`${COMMON}; return { frames, frame, link, onPeerFrame };`)() as {
  frames(onFrame: (type: number, id: number, payload: Buffer) => void): (chunk: Buffer) => void;
  frame(type: number, id: number, payload?: Buffer): Buffer;
  link(socks: Map<number, net.Socket>, send: (b: Buffer) => void, id: number, sock: net.Socket): void;
  onPeerFrame(socks: Map<number, net.Socket>, type: number, id: number, payload: Buffer): void;
};

export interface RelayOptions {
  containerId: string;
  user: string;
  node: string;
  /** Here: the socket to listen on; in the container: the socket its connections go to. */
  forward: { listen: string; target: string };
  /** In the container: the socket to listen on; here: the socket its connections go to. */
  reverse: { listen: string; target: string };
}

export interface Relay {
  close(): void;
  /** Called once when the relay stops by itself (container stopped, docker exec died). */
  onExit(callback: () => void): void;
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const child = spawnProcess(
    "docker",
    ["exec", "-i", "-u", options.user, options.containerId, options.node, "-e", CONTAINER_SCRIPT, options.forward.target, options.reverse.listen],
    { stdio: "pipe" },
  ) as ChildProcessWithoutNullStreams;
  const socks = new Map<number, net.Socket>();
  const send = (b: Buffer) => {
    if (child.stdin.writable) child.stdin.write(b);
  };
  let next = 2;
  let stderr = "";
  let closed = false;
  const exitCallbacks: (() => void)[] = [];

  await rm(options.forward.listen, { force: true });
  const server = net.createServer((sock) => {
    const id = next;
    next += 2;
    send(HOST.frame(OPEN, id));
    HOST.link(socks, send, id, sock);
  });

  const ready = new Promise<void>((resolve, reject) => {
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c).slice(-2000)));
    child.stdout.on(
      "data",
      HOST.frames((type, id, payload) => {
        if (type === READY) resolve();
        else if (type === OPEN) HOST.link(socks, send, id, net.connect(options.reverse.target));
        else HOST.onPeerFrame(socks, type, id, payload);
      }),
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`The connection to the dev container stopped (code ${code}). ${stderr.trim().split("\n").slice(-2).join(" ")}`));
      for (const sock of socks.values()) sock.destroy();
      socks.clear();
      server.close();
      if (!closed) for (const callback of exitCallbacks) callback();
    });
  });

  const close = () => {
    closed = true;
    server.close();
    for (const sock of socks.values()) sock.destroy();
    socks.clear();
    child.stdin.end();
    child.kill();
  };

  try {
    await ready;
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(options.forward.listen, resolve));
    await chmod(options.forward.listen, 0o600);
  } catch (error) {
    close();
    throw error;
  }
  return { close, onExit: (callback) => exitCallbacks.push(callback) };
}
