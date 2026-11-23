import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";

// Gio.FileIcon handles local files; Spotify uses HTTPS and MPV embeds data URIs.
// Keep network I/O off the shell thread and let callers cancel obsolete art.
export class ArtworkLoader {
  constructor() {
    this._session = new Soup.Session({ timeout: 15 });
  }

  load(url, cancellable, callback) {
    if (cancellable.is_cancelled()) return;
    try {
      if (/^data:/i.test(url)) {
        const comma = url.indexOf(",");
        const header = url.slice(0, comma);
        const payload = url.slice(comma + 1);
        // GLib's decoder silently skips invalid characters, so validate first.
        if (!/^data:image\/[a-z0-9.+-]+;base64$/i.test(header) ||
            !payload.length || payload.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(payload))
          throw new Error("Invalid base64 artwork URI");
        callback(new GLib.Bytes(GLib.base64_decode(payload)));
        return;
      }
      if (!/^https?:\/\//i.test(url)) throw new Error("Unsupported artwork URI");
      const message = Soup.Message.new("GET", url);
      if (!message) throw new Error("Invalid artwork URI");
      this._session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        cancellable,
        (session, result) => {
          let bytes = null;
          try {
            const body = session.send_and_read_finish(result);
            if (message.status_code >= 200 && message.status_code < 300 &&
                body.get_size() > 0)
              bytes = body;
          } catch (_) {}
          if (!cancellable.is_cancelled()) callback(bytes);
        },
      );
    } catch (_) {
      if (!cancellable.is_cancelled()) callback(null);
    }
  }

  destroy() {
    this._session.abort();
  }
}
