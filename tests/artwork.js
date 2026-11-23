// Run with: gjs -m tests/artwork.js [optional live artwork URL]
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GdkPixbuf from "gi://GdkPixbuf";
import Soup from "gi://Soup?version=3.0";
import System from "system";

import { ArtworkLoader } from "../helpers/artwork.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const png = GLib.base64_decode(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
);
const server = new Soup.Server();
server.add_handler(null, (_server, message, path) => {
  if (path === "/redirect") {
    message.set_redirect(302, "/art");
    return;
  }
  message.set_status(path === "/missing" ? 404 : 200, null);
  message.set_response("image/png", Soup.MemoryUse.COPY,
    path === "/empty" ? new Uint8Array() : png);
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const base = server.get_uris()[0].to_string().replace(/\/$/, "");
const loader = new ArtworkLoader();
const load = (url) => new Promise((resolve) =>
  loader.load(url, new Gio.Cancellable(), resolve));

function decode(bytes) {
  const icon = new Gio.BytesIcon({ bytes });
  const [stream] = icon.load(64, null);
  try {
    return GdkPixbuf.Pixbuf.new_from_stream(stream, null);
  } finally {
    stream.close(null);
  }
}

async function run() {
  const dataUrl = `data:image/png;base64,${GLib.base64_encode(png)}`;
  const embedded = await load(dataUrl);
  assert(embedded?.get_size() === png.length, "Data URI: missing image bytes");
  assert(decode(embedded).get_width() === 1, "Data URI: undecodable image");
  for (const url of [
    "data:image/png;base64,",
    "data:image/png;base64,!!!!",
    "data:image/png;base64,AAAA=AAA",
    "data:image/png;base64,AAA",
    "data:image/png;base64,AAAA====",
    "data:image/png,not-base64",
    "data:text/plain;base64,AAAA",
    "data:image/png;base64",
  ])
    assert(await load(url) === null, "Invalid data URI: expected a safe fallback");

  const cancelledData = new Gio.Cancellable();
  cancelledData.cancel();
  loader.load(dataUrl, cancelledData, () => {
    throw new Error("Cancelled data URI must not update the UI");
  });
  print("PASS: base64 image decoding, invalid data URIs, cancelled data URI");

  for (const path of ["/art", "/redirect"]) {
    const bytes = await load(base + path);
    assert(bytes?.get_size() === png.length, `${path}: missing image bytes`);
    assert(decode(bytes).get_width() === 1, `${path}: undecodable image`);
  }
  for (const url of [base + "/missing", base + "/empty", "file:///art", "https://["])
    assert(await load(url) === null, `${url}: expected a safe fallback`);

  const cancellable = new Gio.Cancellable();
  let staleCallback = false;
  loader.load(base + "/art", cancellable, () => { staleCallback = true; });
  cancellable.cancel();
  await new Promise((resolve) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
  }));
  assert(!staleCallback, "Cancelled artwork must not update the UI");
  print("PASS: image download, redirect, HTTP error, empty response, invalid URI, cancellation");

  if (ARGV[0]) {
    const bytes = await load(ARGV[0]);
    assert(bytes !== null, "Live artwork download failed");
    const image = decode(bytes);
    print(`PASS: live artwork downloaded and decoded (${image.width}×${image.height})`);
  }
}

const loop = new GLib.MainLoop(null, false);
let failed = false;
run().catch((error) => {
  logError(error);
  failed = true;
}).finally(() => {
  loader.destroy();
  server.disconnect();
  loop.quit();
});
loop.run();
if (failed) System.exit(1);
