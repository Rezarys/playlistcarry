# playlistcarry

Open in a recent browser, nothing to install: https://rezarys.github.io/playlistcarry/

A one-page tool that opens a NewPipe backup (.zip) in your browser, shows every local playlist and its videos as links, and gives you a playlists file in the format FreeTube's "Import Playlists" button reads.

Not affiliated with NewPipe, FreeTube or YouTube. The names are used here only to say which files this page reads and writes.

## Why

FreeTube imports NewPipe subscriptions but not NewPipe playlists. The request has been open since 2022: "the ability to import playlists from Newpipe, this would allow for a more seamless experience when jumping between Freetube and Newpipe, rather than needing to maintain two separate playlist sets" (https://github.com/FreeTubeApp/FreeTube/issues/2302). This page does that one conversion.

## How to use it

1. In NewPipe, open Settings, then Backup and restore, then Export database. Copy the .zip file to your computer.
2. Open https://rezarys.github.io/playlistcarry/ and choose the .zip (or the newpipe.db file inside it).
3. Click **Download playlists for FreeTube (.db)**.
4. In FreeTube, open Settings, then the Data section, then Import Playlists, and choose the downloaded file.

What goes into the FreeTube file:

- Each local NewPipe playlist that has at least one YouTube video, with its videos in the same order, their titles, channel names and lengths.
- If you already have a FreeTube playlist with the same name, FreeTube adds the videos to it instead of making a second playlist.
- Videos from other services (SoundCloud, PeerTube, Bandcamp) and playlists you bookmarked in NewPipe are not in it, because FreeTube does not take them. They are in the text list.

## What the text list looks like

For an example backup with two playlists, one of them unnamed, and one bookmarked playlist:

```
Music, 2 videos
- Song A (Artist) 3:25
  https://www.youtube.com/watch?v=aaaaaaaaaaa
- Track B (Band) 1:02:03
  https://soundcloud.com/band/track-b

Unnamed playlist 2, 1 video
- Clip C (Channel C) 0:09
  https://www.youtube.com/watch?v=ccccccccccc

Bookmarked playlists
- Lectures (Uni)
  https://www.youtube.com/playlist?list=PL0000000000000000
```

## Privacy

The file is read in your browser, and nothing in this page's code sends it anywhere. The page also sets a Content-Security-Policy (default-src 'none', connect-src 'none', form-action 'none') so that its scripts cannot make network requests, load code from elsewhere or submit a form. It is delivered with the page itself, so it only guards the code you were served. The page uses no cookies, no browser storage, no analytics and no third-party code.

## Status and limits

- It has not been tried on a real NewPipe backup or in a running FreeTube app yet. The tests build example databases with the real SQLite engine, using the table definitions NewPipe publishes, and check the FreeTube file against the keys FreeTube's import asks for. Separately, FreeTube's own playlist import function was run on the file outside the app, with the app around it left out, and took the playlists without a warning. Please open an issue if it does not work for you.
- The backup is read by a small read-only SQLite and zip reader written for this page, with no library. It needs a browser that can unzip by itself (Chrome 103, Firefox 113, Safari 16.4 or later); with an older browser, unzip the backup and choose the newpipe.db file inside it.
- Watch history, subscriptions and settings are not carried over. FreeTube already imports NewPipe subscriptions on its own.

## Watch history: 3 USD, not built yet

Carrying your NewPipe watch history over to FreeTube, so the videos you have already seen show as watched. Nothing is charged now and no date is promised. If you want it, say so on https://github.com/Rezarys/playlistcarry/issues/1 (free GitHub account needed). Not part of this repository and not covered by its license.

## Development

Plain HTML, CSS and JavaScript, no build step. Tests use Node's built-in test runner and its built-in SQLite module (Node 22.5 or later): `node --test tests/*.test.js`.

Built with AI assistance, reviewed and tested by me.

## License

MIT, Younes Z.
