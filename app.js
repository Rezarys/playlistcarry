"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  let backup = null;

  function show(id, on) { $(id).hidden = !on; }

  function status(msg, isError) {
    const el = $("status");
    el.textContent = msg;
    el.className = isError ? "error" : "";
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function link(url, label) {
    if (!isSafeUrl(url)) {
      const span = document.createElement("span");
      span.textContent = label + " " + url;
      return span;
    }
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    return a;
  }

  function render() {
    const list = $("list");
    list.textContent = "";
    for (const l of backup.lists) {
      const d = document.createElement("details");
      const s = document.createElement("summary");
      const yt = l.items.filter((i) => i.videoId).length;
      let label = l.name + ", " + l.items.length + (l.items.length === 1 ? " video" : " videos");
      if (yt !== l.items.length) label += " (" + yt + " on YouTube)";
      s.textContent = label;
      d.appendChild(s);
      const ol = document.createElement("ol");
      for (const i of l.items) {
        const li = document.createElement("li");
        li.appendChild(link(i.url, i.title));
        const t = duration(i.seconds);
        const extra = (i.uploader ? " " + i.uploader : "") + (t ? " " + t : "");
        if (extra) {
          const small = document.createElement("span");
          small.className = "small";
          small.textContent = extra;
          li.appendChild(small);
        }
        ol.appendChild(li);
      }
      d.appendChild(ol);
      list.appendChild(d);
    }
    if (backup.bookmarked.length) {
      const h = document.createElement("h2");
      h.textContent = "Bookmarked playlists (not copied, links only)";
      list.appendChild(h);
      const ul = document.createElement("ul");
      for (const b of backup.bookmarked) {
        const li = document.createElement("li");
        li.appendChild(link(b.url, b.name));
        ul.appendChild(li);
      }
      list.appendChild(ul);
    }
    const c = counts(backup);
    let msg = c.lists + (c.lists === 1 ? " playlist, " : " playlists, ") + c.videos + (c.videos === 1 ? " video" : " videos");
    if (c.other) msg += ", of which " + c.youtube + " on YouTube";
    if (!c.lists) msg = "No local playlists in this backup.";
    status(msg + ".", false);
    show("actions", c.lists > 0 || c.bookmarked > 0);
    $("freetube").disabled = !c.youtube;
  }

  $("file").addEventListener("change", async () => {
    const f = ($("file").files || [])[0];
    if (!f) return;
    backup = null;
    show("actions", false);
    $("list").textContent = "";
    status("Reading...", false);
    try {
      backup = await readBackup(new Uint8Array(await f.arrayBuffer()));
      render();
    } catch (err) {
      status(f.name + ": " + (err instanceof BackupError ? err.message : "could not be read."), true);
    }
  });

  $("freetube").addEventListener("click", () => {
    const text = freeTubeFile(backup.lists, Date.now(), () => crypto.randomUUID());
    download("newpipe-playlists-for-freetube.db", text, "application/octet-stream");
  });
  $("text").addEventListener("click", () => {
    download("newpipe-playlists.txt", textList(backup), "text/plain");
  });
  $("clear").addEventListener("click", () => {
    backup = null;
    $("file").value = "";
    $("list").textContent = "";
    show("actions", false);
    status("Cleared.", false);
  });
})();
