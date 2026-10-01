const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const r = require("../reader.js");
const p = require("../playlists.js");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "playlistcarry-"));

// Table statements as NewPipe's published database schema (version 9) writes them.
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS `streams` (`uid` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `service_id` INTEGER NOT NULL, `url` TEXT NOT NULL, `title` TEXT NOT NULL, `stream_type` TEXT NOT NULL, `duration` INTEGER NOT NULL, `uploader` TEXT NOT NULL, `uploader_url` TEXT, `thumbnail_url` TEXT, `view_count` INTEGER, `textual_upload_date` TEXT, `upload_date` INTEGER, `is_upload_date_approximation` INTEGER)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `index_streams_service_id_url` ON `streams` (`service_id`, `url`)",
  "CREATE TABLE IF NOT EXISTS `playlists` (`uid` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `name` TEXT, `is_thumbnail_permanent` INTEGER NOT NULL, `thumbnail_stream_id` INTEGER NOT NULL, `display_index` INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `playlist_stream_join` (`playlist_id` INTEGER NOT NULL, `stream_id` INTEGER NOT NULL, `join_index` INTEGER NOT NULL, PRIMARY KEY(`playlist_id`, `join_index`), FOREIGN KEY(`playlist_id`) REFERENCES `playlists`(`uid`) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(`stream_id`) REFERENCES `streams`(`uid`) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)",
  "CREATE TABLE IF NOT EXISTS `remote_playlists` (`uid` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `service_id` INTEGER NOT NULL, `name` TEXT, `url` TEXT, `thumbnail_url` TEXT, `uploader` TEXT, `display_index` INTEGER NOT NULL, `stream_count` INTEGER)",
];

let fileNo = 0;

// Builds a database file with the real SQLite engine and returns its bytes.
function buildDb(fill, pageSize) {
  const file = path.join(TMP, "db" + ++fileNo + ".db");
  const db = new DatabaseSync(file);
  if (pageSize) db.exec("PRAGMA page_size = " + pageSize);
  for (const s of SCHEMA) db.exec(s);
  fill(db);
  db.close();
  return new Uint8Array(fs.readFileSync(file));
}

function addStream(db, uid, service, url, title, seconds, uploader, uploaderUrl) {
  db.prepare("INSERT INTO streams (uid, service_id, url, title, stream_type, duration, uploader, uploader_url, upload_date) VALUES (?, ?, ?, ?, 'VIDEO_STREAM', ?, ?, ?, ?)")
    .run(uid, service, url, title, seconds, uploader, uploaderUrl, 1759276800123);
}

function addPlaylist(db, uid, name, index, streamIds) {
  db.prepare("INSERT INTO playlists (uid, name, is_thumbnail_permanent, thumbnail_stream_id, display_index) VALUES (?, ?, 0, -1, ?)")
    .run(uid, name, index);
  const join = db.prepare("INSERT INTO playlist_stream_join (playlist_id, stream_id, join_index) VALUES (?, ?, ?)");
  streamIds.forEach((s, i) => join.run(uid, s, i));
}

// The example backup: two playlists inserted out of display order, one SoundCloud track, one bookmark.
function exampleDb() {
  return buildDb((db) => {
    addStream(db, 1, 0, "https://www.youtube.com/watch?v=aaaaaaaaaaa", "Song A", 205, "Artist", "https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa");
    addStream(db, 2, 1, "https://soundcloud.com/band/track-b", "Track B", 3723, "Band", "https://soundcloud.com/band");
    addStream(db, 3, 0, "https://www.youtube.com/watch?v=ccccccccccc", "Clip C", 9, "Channel C", "https://www.youtube.com/@channelc");
    addPlaylist(db, 7, null, 1, [3]);
    addPlaylist(db, 4, "Music", 0, [1, 2]);
    db.prepare("INSERT INTO remote_playlists (service_id, name, url, uploader, display_index, stream_count) VALUES (0, 'Lectures', 'https://www.youtube.com/playlist?list=PL0000000000000000', 'Uni', 0, 12)").run();
  });
}

function crc32(b) {
  return zlib.crc32(b) >>> 0;
}

// Writes a zip the way Java's ZipOutputStream does: deflated, sizes in a trailing data descriptor.
function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name);
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(nameBytes.length, 26);
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(comp.length, 8);
    desc.writeUInt32LE(data.length, 12);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0808, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);
    parts.push(local, nameBytes, comp, desc);
    offset += local.length + nameBytes.length + comp.length + desc.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, end]));
}

const README_SAMPLE = [
  "Music, 2 videos",
  "- Song A (Artist) 3:25",
  "  https://www.youtube.com/watch?v=aaaaaaaaaaa",
  "- Track B (Band) 1:02:03",
  "  https://soundcloud.com/band/track-b",
  "",
  "Unnamed playlist 2, 1 video",
  "- Clip C (Channel C) 0:09",
  "  https://www.youtube.com/watch?v=ccccccccccc",
  "",
  "Bookmarked playlists",
  "- Lectures (Uni)",
  "  https://www.youtube.com/playlist?list=PL0000000000000000",
  "",
].join("\n");

test("reads column names from NewPipe's table statements", () => {
  const t = r.tableColumns(SCHEMA[3]);
  assert.deepStrictEqual(t.columns, ["playlist_id", "stream_id", "join_index"]);
  assert.strictEqual(t.rowidColumn, -1);
  const s = r.tableColumns(SCHEMA[0]);
  assert.strictEqual(s.columns.length, 13);
  assert.strictEqual(s.rowidColumn, 0);
});

test("reads playlists in NewPipe's display order and video order", async () => {
  const b = await p.readBackup(exampleDb());
  assert.deepStrictEqual(b.lists.map((l) => l.name), ["Music", "Unnamed playlist 2"]);
  assert.deepStrictEqual(b.lists[0].items.map((i) => i.title), ["Song A", "Track B"]);
  assert.strictEqual(b.lists[0].items[0].videoId, "aaaaaaaaaaa");
  assert.strictEqual(b.lists[0].items[1].videoId, null, "SoundCloud is not YouTube");
  assert.strictEqual(b.lists[0].items[1].seconds, 3723);
  assert.deepStrictEqual(b.bookmarked, [{ name: "Lectures", url: "https://www.youtube.com/playlist?list=PL0000000000000000", uploader: "Uni", count: 12 }]);
  assert.deepStrictEqual(p.counts(b), { lists: 2, videos: 3, youtube: 2, other: 1, bookmarked: 1 });
});

test("a backup zip gives the same result as the database inside it", async () => {
  const dbBytes = exampleDb();
  const zip = buildZip([["newpipe.db", dbBytes], ["preferences.json", Buffer.from('{"a": 1}')]]);
  assert.deepStrictEqual(await p.readBackup(zip), await p.readBackup(dbBytes));
  assert.deepStrictEqual(r.zipEntries(zip).map((e) => e.name), ["newpipe.db", "preferences.json"]);
});

test("text list matches the sample in the README", async () => {
  const out = p.textList(await p.readBackup(exampleDb()));
  assert.strictEqual(out, README_SAMPLE);
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes("```\n" + README_SAMPLE + "```"), "README sample is out of date");
});

test("FreeTube file has one playlist per line and the keys FreeTube's import asks for", async () => {
  let n = 0;
  const out = p.freeTubeFile((await p.readBackup(exampleDb())).lists, 1760000000000, () => "id-" + ++n);
  assert.ok(out.endsWith("\n"), "FreeTube drops the last line, so the file must end with a newline");
  const lines = out.split("\n");
  lines.pop();
  const lists = lines.map((l) => JSON.parse(l));
  assert.strictEqual(lists.length, 2);
  // The playlist keys FreeTube's import accepts without a warning, as listed in its import code.
  const known = ["playlistName", "videos", "_id", "description", "createdAt", "title", "type", "protected",
    "lastUpdatedAt", "lastPlayedAt", "removeOnWatched", "thumbnail", "channelName", "channelId", "playlistId", "videoCount"];
  for (const l of lists) {
    for (const k of Object.keys(l)) assert.ok(known.includes(k), "unknown key " + k);
    for (const v of l.videos) {
      for (const k of ["videoId", "title", "lengthSeconds", "timeAdded"]) assert.ok(k in v, "missing " + k);
    }
  }
  assert.strictEqual(lists[0].playlistName, "Music");
  assert.deepStrictEqual(lists[0].videos, [{
    videoId: "aaaaaaaaaaa", title: "Song A", author: "Artist", authorId: "UCaaaaaaaaaaaaaaaaaaaaaa",
    lengthSeconds: 205, timeAdded: 1759999999999, playlistItemId: "id-1", type: "video",
  }]);
  assert.strictEqual(lists[1].videos[0].authorId, undefined, "a handle address is not a channel id");
});

test("lists with no YouTube video are left out of the FreeTube file", () => {
  const out = p.freeTubeFile([{ name: "x", items: [{ videoId: null }] }, { name: "y", items: [] }], 1, () => "z");
  assert.strictEqual(out, "\n");
});

test("added times keep the playlist order and are all in the past", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ videoId: "v".repeat(10) + i, title: "t", uploader: "", seconds: 1 }));
  const v = JSON.parse(p.freeTubeFile([{ name: "a", items }], 1000, () => "i").trim()).videos;
  assert.deepStrictEqual(v.map((x) => x.timeAdded), [995, 996, 997, 998, 999]);
});

test("reads thousands of rows across many pages, and long titles that spill over pages", async () => {
  const long = "Long title " + "é".repeat(3000) + " end";
  const ids = [];
  const bytes = buildDb((db) => {
    db.exec("BEGIN");
    for (let i = 1; i <= 3000; i++) {
      const vid = String(i).padStart(11, "x");
      addStream(db, i, 0, "https://www.youtube.com/watch?v=" + vid, i === 1500 ? long : "Video " + i + " 🎵", i, "U", null);
      ids.push(i);
    }
    addPlaylist(db, 1, "Big", 0, ids.slice().reverse());
    db.exec("COMMIT");
  }, 1024);
  assert.ok(bytes.length > 100 * 1024, "the test must span many pages");
  const b = await p.readBackup(bytes);
  const items = b.lists[0].items;
  assert.strictEqual(items.length, 3000);
  assert.strictEqual(items[0].title, "Video 3000 🎵");
  assert.strictEqual(items[2999].title, "Video 1 🎵");
  assert.strictEqual(items[1500].title, long);
  assert.strictEqual(items[1500].seconds, 1500);
});

test("reads large integers and columns added to a table after rows were written", () => {
  const bytes = buildDb((db) => {
    db.exec("CREATE TABLE t (`id` INTEGER PRIMARY KEY, `a` INTEGER)");
    db.prepare("INSERT INTO t (a) VALUES (?)").run(1759276800123);
    db.prepare("INSERT INTO t (a) VALUES (?)").run(-70000);
    db.exec("ALTER TABLE t ADD COLUMN `b` TEXT");
    db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(3, "new");
  });
  const rows = r.openDatabase(bytes).rows("t");
  assert.deepStrictEqual(rows, [
    { id: 1, a: 1759276800123, b: null },
    { id: 2, a: -70000, b: null },
    { id: 3, a: 3, b: "new" },
  ]);
});

test("recognises YouTube video and channel addresses", () => {
  const id = "dQw4w9WgXcQ";
  for (const u of [
    "https://www.youtube.com/watch?v=" + id, "https://m.youtube.com/watch?v=" + id + "&t=4",
    "https://youtu.be/" + id, "https://www.youtube.com/shorts/" + id, "https://music.youtube.com/watch?v=" + id,
    "https://www.youtube.com/live/" + id,
  ]) assert.strictEqual(p.youtubeVideoId(u), id, u);
  for (const u of ["https://example.com/watch?v=" + id, "https://www.youtube.com/watch?v=short", "not a url", ""]) {
    assert.strictEqual(p.youtubeVideoId(u), null, u);
  }
  assert.strictEqual(p.youtubeChannelId("https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"), "UCaaaaaaaaaaaaaaaaaaaaaa");
  assert.strictEqual(p.youtubeChannelId("https://www.youtube.com/@name"), null);
});

test("refuses files that are not a NewPipe backup", async () => {
  await assert.rejects(p.readBackup(new Uint8Array(Buffer.from("hello world, not a backup"))), r.BackupError);
  await assert.rejects(p.readBackup(buildZip([["other.txt", Buffer.from("x")]])), /no newpipe\.db/);
  await assert.rejects(p.readBackup(buildDb((db) => db.exec("DROP TABLE playlists"))), /no playlists table/);
  assert.strictEqual((await p.readBackup(buildDb(() => {}))).lists.length, 0);
});

test("refuses a cut database instead of reading past its end", async () => {
  const bytes = exampleDb();
  await assert.rejects(p.readBackup(bytes.slice(0, 4096)), /damaged or incomplete/);
});

test("only web links are treated as safe", () => {
  for (const u of ["https://a.example/", "http://a.example/", "HTTPS://A.EXAMPLE/"]) assert.ok(p.isSafeUrl(u), u);
  for (const u of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,x", "file:///x", "", null]) {
    assert.ok(!p.isSafeUrl(u), String(u));
  }
});

test("public files have no long dash", () => {
  const dash = String.fromCharCode(0x2014);
  for (const f of ["README.md", "index.html", "app.js", "reader.js", "playlists.js", "style.css"]) {
    assert.ok(!fs.readFileSync(path.join(ROOT, f), "utf8").includes(dash), f);
  }
});
