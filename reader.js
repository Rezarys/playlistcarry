// Reads a zip archive and a SQLite database file in the browser, read only, with no library.
// Only what a NewPipe backup needs: stored or deflated zip entries, and table rows of a SQLite file.
// The SQLite reader follows the published file format (https://www.sqlite.org/fileformat.html).
"use strict";

class BackupError extends Error {}

// ---- zip ----

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }

const OLD_BROWSER = "This browser cannot unzip files by itself. Use Chrome 103, Firefox 113, Safari 16.4 or later, "
  + "or unzip the backup and choose the newpipe.db file inside it.";

async function inflateRaw(data) {
  let unzip;
  try {
    unzip = new DecompressionStream("deflate-raw");
  } catch (e) {
    throw new BackupError(OLD_BROWSER);
  }
  const stream = new Blob([data]).stream().pipeThrough(unzip);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Lists the entries of a zip file from its central directory.
// The central directory is used because the local headers written by Java leave the sizes at zero.
function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new BackupError("This is not a zip file.");
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new BackupError("This zip file is too large to be read here.");
  const names = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new BackupError("The zip file is damaged.");
    const nameLen = u16(bytes, p + 28);
    entries.push({
      name: names.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      flags: u16(bytes, p + 8),
      method: u16(bytes, p + 10),
      compressedSize: u32(bytes, p + 20),
      size: u32(bytes, p + 24),
      offset: u32(bytes, p + 42),
    });
    p += 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
  }
  return entries;
}

// Returns the bytes of the first entry whose file name (without folders) is `wanted`, or null.
async function zipRead(bytes, wanted) {
  const e = zipEntries(bytes).find((x) => x.name.split("/").pop() === wanted);
  if (!e) return null;
  if (e.flags & 1) throw new BackupError("The zip file is password protected.");
  if (u32(bytes, e.offset) !== 0x04034b50) throw new BackupError("The zip file is damaged.");
  const start = e.offset + 30 + u16(bytes, e.offset + 26) + u16(bytes, e.offset + 28);
  const data = bytes.subarray(start, start + e.compressedSize);
  let out;
  if (e.method === 0) out = data;
  else if (e.method === 8) out = await inflateRaw(data);
  else throw new BackupError("The zip file uses a compression this page does not read.");
  if (out.length !== e.size) throw new BackupError("The zip file is damaged.");
  return out;
}

// ---- SQLite ----

function readVarint(b, p) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const c = b[p + i];
    v = v * 128 + (c & 0x7f);
    if (!(c & 0x80)) return [v, i + 1];
  }
  return [v * 256 + b[p + 8], 9];
}

// Splits a CREATE TABLE statement into its column names, and finds the column that stands for the row id.
function tableColumns(sql) {
  const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
  const parts = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "`" || ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      quote = "]";
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  const columns = [];
  let rowidColumn = -1;
  for (const raw of parts) {
    const def = raw.trim();
    if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(def)) continue;
    const m = /^(`[^`]*`|"[^"]*"|\[[^\]]*\]|\S+)\s*(.*)$/s.exec(def);
    if (!m) continue;
    const name = /^[`"[]/.test(m[1]) ? m[1].slice(1, -1) : m[1];
    if (/^INTEGER\s+PRIMARY\s+KEY\b/i.test(m[2])) rowidColumn = columns.length;
    columns.push(name);
  }
  return { columns, rowidColumn };
}

function openDatabase(bytes) {
  const magic = "SQLite format 3\0";
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) throw new BackupError("This is not a SQLite database.");
  }
  let pageSize = (bytes[16] << 8) | bytes[17];
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || (pageSize & (pageSize - 1))) throw new BackupError("The database is damaged.");
  const usable = pageSize - bytes[20];
  const encoding = ((bytes[56] << 24) | (bytes[57] << 16) | (bytes[58] << 8) | bytes[59]) || 1;
  const text = new TextDecoder(encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8");
  const pageCount = Math.floor(bytes.length / pageSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function pageStart(n) {
    if (n < 1 || n > pageCount) throw new BackupError("The database is damaged or incomplete.");
    return (n - 1) * pageSize;
  }

  function payload(p, size) {
    const maxLocal = usable - 35;
    let local = size;
    if (size > maxLocal) {
      const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
      local = minLocal + ((size - minLocal) % (usable - 4));
      if (local > maxLocal) local = minLocal;
    }
    if (local === size) return bytes.subarray(p, p + size);
    const out = new Uint8Array(size);
    out.set(bytes.subarray(p, p + local), 0);
    let done = local;
    let next = view.getUint32(p + local);
    let hops = 0;
    while (done < size) {
      if (++hops > pageCount) throw new BackupError("The database is damaged.");
      const o = pageStart(next);
      const n = Math.min(size - done, usable - 4);
      out.set(bytes.subarray(o + 4, o + 4 + n), done);
      done += n;
      next = view.getUint32(o);
    }
    return out;
  }

  function record(b) {
    const [headerSize, h] = readVarint(b, 0);
    const types = [];
    for (let p = h; p < headerSize;) {
      const [t, n] = readVarint(b, p);
      types.push(t);
      p += n;
    }
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const values = [];
    let p = headerSize;
    for (const t of types) {
      if (t === 0) values.push(null);
      else if (t === 1) { values.push(v.getInt8(p)); p += 1; }
      else if (t === 2) { values.push(v.getInt16(p)); p += 2; }
      else if (t === 3) { values.push((v.getInt8(p) << 16) | v.getUint16(p + 1)); p += 3; }
      else if (t === 4) { values.push(v.getInt32(p)); p += 4; }
      else if (t === 5) { values.push(v.getInt16(p) * 0x100000000 + v.getUint32(p + 2)); p += 6; }
      else if (t === 6) { values.push(Number(v.getBigInt64(p))); p += 8; }
      else if (t === 7) { values.push(v.getFloat64(p)); p += 8; }
      else if (t === 8) values.push(0);
      else if (t === 9) values.push(1);
      else if (t >= 12) {
        const n = (t - (t % 2 ? 13 : 12)) / 2;
        const slice = b.subarray(p, p + n);
        values.push(t % 2 ? text.decode(slice) : slice.slice());
        p += n;
      } else throw new BackupError("The database is damaged.");
    }
    return values;
  }

  // Visits every row of a table b-tree in row id order, as [rowid, values].
  function scan(root) {
    const rows = [];
    const seen = new Set();
    function visit(n, depth) {
      if (seen.has(n) || depth > 40) throw new BackupError("The database is damaged.");
      seen.add(n);
      const base = pageStart(n);
      const h = n === 1 ? base + 100 : base;
      const type = bytes[h];
      const cells = (bytes[h + 3] << 8) | bytes[h + 4];
      if (type === 13) {
        for (let i = 0; i < cells; i++) {
          let p = base + ((bytes[h + 8 + 2 * i] << 8) | bytes[h + 9 + 2 * i]);
          const [size, a] = readVarint(bytes, p);
          p += a;
          const [rowid, c] = readVarint(bytes, p);
          p += c;
          rows.push([rowid, record(payload(p, size))]);
        }
      } else if (type === 5) {
        for (let i = 0; i < cells; i++) {
          const p = base + ((bytes[h + 12 + 2 * i] << 8) | bytes[h + 13 + 2 * i]);
          visit(view.getUint32(p), depth + 1);
        }
        visit(view.getUint32(h + 8), depth + 1);
      } else {
        throw new BackupError("The database is damaged.");
      }
    }
    visit(root, 0);
    return rows;
  }

  const schema = scan(1).map(([, v]) => ({ type: v[0], name: v[1], root: v[3], sql: v[4] }));

  function hasTable(name) {
    return schema.some((s) => s.type === "table" && s.name === name);
  }

  // Returns the rows of a table as plain objects keyed by column name.
  function rows(name) {
    const t = schema.find((s) => s.type === "table" && s.name === name);
    if (!t) throw new BackupError("The database has no table named " + name + ".");
    const { columns, rowidColumn } = tableColumns(t.sql || "");
    return scan(t.root).map(([rowid, values]) => {
      const o = {};
      columns.forEach((c, i) => { o[c] = i < values.length ? values[i] : null; });
      if (rowidColumn >= 0 && o[columns[rowidColumn]] === null) o[columns[rowidColumn]] = rowid;
      return o;
    });
  }

  return { hasTable, rows };
}

if (typeof module !== "undefined") {
  module.exports = { BackupError, zipEntries, zipRead, openDatabase, tableColumns, readVarint };
}
