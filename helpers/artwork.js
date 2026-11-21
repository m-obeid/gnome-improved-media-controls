import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";

// Gio.FileIcon handles local files, but Spotify publishes HTTPS artwork.
// Keep network I/O off the shell thread and let callers cancel obsolete art.
export class ArtworkLoader {
  constructor() {
    this._session = new Soup.Session({ timeout: 15 });
  }

  load(url, cancellable, callback) {
    try {
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
