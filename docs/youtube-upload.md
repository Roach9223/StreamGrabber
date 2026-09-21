# StreamGrabber: YouTube upload kit

Everything for the upload form. Pick one title, paste the description as is (fix the timestamps after your edit), paste the tags block into the tags field.

## Title (pick one, all under 60 characters)

1. I built a free tool that strips the ads off sports streams
2. Sports streaming sites are a mess, so I fixed it (free tool)
3. StreamGrabber: raw sports streams in mpv, no ads, no popups
4. Watch the game without the popups. Free, open source.
5. $500 for NFL Sunday Ticket, or this free tool

The first one is the strongest hook. Number 5 gets clicks but invites the comment section to argue about pricing instead of the tool.

## Description

```
Free sports streaming sites bury the game under ads, popups, and a player that's throttled on purpose. StreamGrabber pulls the raw video feed out of the page and plays it in mpv. No ads, no popups, nothing running in your browser.

Download (Windows, one exe, free):
https://github.com/Roach9223/StreamGrabber/releases/latest

Source code:
https://github.com/Roach9223/StreamGrabber

You need mpv installed (winget install mpv) and Edge or Chrome on the machine. That's it. Windows will warn that the exe isn't signed: click More info, then Run anyway.

How it works: it loads the match page in a browser you never see, watches the network for the actual HLS stream, works out which site the video host expects the request to come from, and hands both to mpv. Paste the link before the game and hit Watch for kickoff, and it starts the stream on its own when the feed goes up.

If it breaks on a site you use, open an issue on GitHub with the log from the app and I'll take a look.

Use it on streams you have the right to watch.

0:00 The problem with free streaming sites
0:18 StreamGrabber
0:28 Paste and Convert
0:45 Stream in mpv
0:56 Watch for kickoff
1:08 Why I made it
1:25 Download

#StreamGrabber #OpenSource #mpv
```

The timestamps assume the 90 second cut at a normal pace. Fix them against the final edit before publishing; YouTube only builds chapters if the first one is 0:00 and each chapter is at least 10 seconds.

## Tags (paste the whole block, 470 characters)

```
StreamGrabber, sports streaming, watch sports free, nfl stream, sports stream no ads, ad free streaming, mpv, mpv player, hls stream, m3u8, stream grabber, free software, open source, windows app, freeware, ad blocker for streams, popup free streaming, how to watch nfl without sunday ticket, live sports, streaming tool, github project, node.js, playwright, indie developer, i built a tool
```

## Settings

- Category: Science & Technology
- Audience: not made for kids
- Comments: on, hold potentially inappropriate for review
- License: Standard YouTube
- Add to a playlist if you have one for your tools; the YouTube to MP3 video belongs next to it
- End screen: link the GitHub release as the card, and the YouTube to MP3 video as the suggested video

## Thumbnail

Dark background, the green play mark from the app icon, big text. Options for the text:

1. NO ADS. NO POPUPS.
2. $500 vs FREE
3. THE GAME. NOTHING ELSE.
4. FREE TOOL

Three finished options are in `docs/marketing/thumbnails/`: `thumbnail-no-ads.png` (option 1 on the ad-tangle illustration), `thumbnail-price.png` (option 2 with the app window), `thumbnail-the-game.png` (option 3 on the player illustration). `tools/make-thumbnail.js` re-renders them; edit the text there and rerun.

## Pinned comment

```
Download: https://github.com/Roach9223/StreamGrabber/releases/latest
Needs mpv (winget install mpv). If a site doesn't work, open an issue with the log from the app and I'll take a look.
```

## Community post (optional, same day)

```
New tool out. Paste a sports stream link, get the raw feed in mpv. No ads, no popups. Free, open source, one exe. Video and download in the link.
```
