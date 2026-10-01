// Turns the local playlists of a NewPipe backup into a playlists file that FreeTube can import.
// NewPipe tables read: playlists, playlist_stream_join, streams, remote_playlists.
// FreeTube file written: one JSON playlist per line, with the keys its playlist import asks for.
// The table and key names are the ones both apps publish; no code of either app is used.
"use strict";

const reader = typeof module !== "undefined" ? require("./reader.js") : { BackupError, zipRead, openDatabase };

const SAFE_SCHEMES = ["http:", "https:"];

function isSafeUrl(url) {
  if (typeof url !== "string") return false;
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(url.trim());
  return !!m && SAFE_SCHEMES.includes(m[1].toLowerCase());
}

const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"];

// Returns the 11 character video id of a YouTube address, or null.
function youtubeVideoId(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  let id = null;
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be") id = u.pathname.split("/")[1];
  else if (YOUTUBE_HOSTS.includes(host)) {
    const parts = u.pathname.split("/");
    if (parts[1] === "watch") id = u.searchParams.get("v");
    else if (["shorts", "live", "embed", "v"].includes(parts[1])) id = parts[2];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

// Returns the channel id (UC...) of a YouTube channel address, or null.
function youtubeChannelId(url) {
  if (typeof url !== "string") return null;
  const m = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/.exec(url);
  return m ? m[1] : null;
}

function byNumber(key) {
  return (a, b) => (Number(a[key]) || 0) - (Number(b[key]) || 0);
}

// Reads a NewPipe backup (the .zip, or the newpipe.db inside it) into plain lists.
async function readBackup(bytes) {
  let db = bytes;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    db = await reader.zipRead(bytes, "newpipe.db");
    if (!db) throw new reader.BackupError("This zip file has no newpipe.db inside. Is it a NewPipe backup?");
  }
  return readDatabase(reader.openDatabase(db));
}

function readDatabase(db) {
  for (const t of ["playlists", "playlist_stream_join", "streams"]) {
    if (!db.hasTable(t)) throw new reader.BackupError("This database has no " + t + " table. Is it from NewPipe?");
  }
  const streams = new Map(db.rows("streams").map((s) => [s.uid, s]));
  const joins = new Map();
  for (const j of db.rows("playlist_stream_join")) {
    if (!joins.has(j.playlist_id)) joins.set(j.playlist_id, []);
    joins.get(j.playlist_id).push(j);
  }
  const playlists = db.rows("playlists").sort(byNumber("uid")).sort(byNumber("display_index"));
  const lists = playlists.map((p, n) => {
    const items = (joins.get(p.uid) || []).sort(byNumber("join_index")).map((j) => {
      const s = streams.get(j.stream_id) || {};
      const url = typeof s.url === "string" ? s.url : "";
      return {
        url,
        title: s.title || url,
        uploader: s.uploader || "",
        uploaderUrl: s.uploader_url || "",
        seconds: Number(s.duration) > 0 ? Number(s.duration) : 0,
        videoId: s.service_id === 0 ? youtubeVideoId(url) : null,
      };
    });
    return { name: p.name || "Unnamed playlist " + (n + 1), items };
  });
  const bookmarked = db.hasTable("remote_playlists")
    ? db.rows("remote_playlists").sort(byNumber("uid")).sort(byNumber("display_index")).map((r) => ({
      name: r.name || r.url || "",
      url: r.url || "",
      uploader: r.uploader || "",
      count: Number(r.stream_count) >= 0 && r.stream_count !== null ? Number(r.stream_count) : null,
    }))
    : [];
  return { lists, bookmarked };
}

// Writes the FreeTube playlists file. Videos that are not on YouTube are left out, and so are empty lists.
// `now` is a time in milliseconds; each video gets an added time just before it, in list order.
function freeTubeFile(lists, now, newId) {
  const lines = [];
  for (const l of lists) {
    const yt = l.items.filter((i) => i.videoId);
    if (!yt.length) continue;
    const videos = yt.map((i, k) => {
      const v = { videoId: i.videoId, title: i.title, author: i.uploader };
      const channel = youtubeChannelId(i.uploaderUrl);
      if (channel) v.authorId = channel;
      v.lengthSeconds = i.seconds;
      v.timeAdded = now - yt.length + k;
      v.playlistItemId = newId();
      v.type = "video";
      return v;
    });
    lines.push(JSON.stringify({ playlistName: l.name, description: "", videos }));
  }
  return lines.join("\n") + "\n";
}

function counts(backup) {
  let videos = 0;
  let youtube = 0;
  for (const l of backup.lists) {
    videos += l.items.length;
    youtube += l.items.filter((i) => i.videoId).length;
  }
  return { lists: backup.lists.length, videos, youtube, other: videos - youtube, bookmarked: backup.bookmarked.length };
}

function duration(s) {
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

// Plain text list of every playlist and every bookmarked playlist, including videos FreeTube cannot take.
function textList(backup) {
  const out = [];
  for (const l of backup.lists) {
    out.push(l.name + ", " + plural(l.items.length, "video"));
    for (const i of l.items) {
      const t = duration(i.seconds);
      out.push("- " + i.title + (i.uploader ? " (" + i.uploader + ")" : "") + (t ? " " + t : ""));
      out.push("  " + i.url);
    }
    out.push("");
  }
  if (backup.bookmarked.length) {
    out.push("Bookmarked playlists");
    for (const b of backup.bookmarked) {
      out.push("- " + b.name + (b.uploader ? " (" + b.uploader + ")" : ""));
      out.push("  " + b.url);
    }
    out.push("");
  }
  return out.join("\n");
}

if (typeof module !== "undefined") {
  module.exports = {
    isSafeUrl, youtubeVideoId, youtubeChannelId, readBackup, readDatabase, freeTubeFile, counts, textList, duration,
  };
}
