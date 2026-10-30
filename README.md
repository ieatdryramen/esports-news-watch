# esports-news-watch

A free breaking-news watcher for long-running esports scenes: CS2, Melee, Age of Empires II, Dota, Classic Tetris, Brood War, Trackmania, Warcraft III, classic Street Fighter, and Halo.

Every 5 minutes it checks public news feeds, Google News, Reddit, and (optionally) Bluesky accounts, scores each new story with simple keyword rules, and posts the big ones to a Discord channel. It runs on GitHub Actions, so it costs nothing in a public repo.

Fork it and point it at your own scenes.

## How it decides what's breaking

Each new story gets a score:

- **Breaking words** like *banned*, *retires*, *signs*, *upset*, *convicted*, *cancelled*, *world record* (`config/scoring.json`)
- **Plus big names** for that scene: players, teams, events (`config/scenes.json`)
- **Plus a small bonus** for news outlets over Reddit posts
- **Minus noise words** like *meme*, *clip*, *help*, *prediction market*

A story needs at least one breaking word to alert at all. Scores at or above `thresholds.breaking` post as 🚨 **BREAKING**; at or above `thresholds.possible` they post as ⚠️ **POSSIBLE BREAKING**. The same story from several sources alerts once. Stories older than 6 hours are ignored.

The first time a source is fetched, everything already in it is recorded as seen, so you don't get flooded on setup.

## Setup

1. **Fork or copy this repo** (keep it public for free Actions minutes).
2. **Discord webhook:** in your Discord server, open the channel's settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
3. In the repo: **Settings → Secrets and variables → Actions → New repository secret**, name it `DISCORD_WEBHOOK_URL`, paste the URL.
4. **Reddit** works with no setup: all subreddits are pulled in one public RSS request. If Reddit starts blocking it, and you have Reddit API keys (new keys need Reddit's approval since late 2025), add them as secrets `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`.
5. **Optional, pings:** add a repository *variable* (not secret) `ALERT_MENTION` set to `@here` or a role mention like `<@&ROLE_ID>` to ping on BREAKING alerts.
6. **Actions tab → watch → Run workflow → mode: check.** The log shows which sources work and what would alert right now. Then it runs on its own every 5 minutes.

## Tournament results (start.gg)

With a free start.gg personal access token in the secret `STARTGG_TOKEN`, the watch run checks start.gg every 30 minutes for the games in `config/startgg.json` (Melee and the fighting games, which mostly run their brackets there). It publishes `results.json` on the `feed` branch (finished events with top 8, live events, and the next week's events), adds a Results section to the daily rundown, and posts a 🏆 RESULT to Discord when a major (`majorEntrants` or bigger) finishes. Tune the entrant thresholds per game in the config. Run **watch** with mode `check` to see which start.gg games matched.

## Daily rundown

The **watch** run refreshes `rundown.json` on the `feed` branch every hour (every story from the last 24 hours, grouped by scene) and posts the rundown to Discord twice a day, at 7:00 and 17:00 in `RUNDOWN_TIMEZONE` (default US Eastern). Change the hours with a repository variable `RUNDOWN_POST_HOURS` (e.g. `8,20`). Hitting **Actions → rundown → Run workflow** posts it right away. To send it to a different channel, add a second webhook as the secret `DISCORD_RUNDOWN_WEBHOOK_URL`.

News sites always make the rundown. Reddit posts only make it if the title hits a breaking term, a known player or team, or a news word from `rundownRedditTerms` in `config/scoring.json`, so help posts, memes and clips from busy player subs stay out.

## Tuning

- Too many alerts: raise the thresholds in `config/scoring.json`, or add noise words.
- Missed a story: add the word that would have caught it to `breakingTerms`, or the player/team to that scene's `names`.
- New scene: add it to `config/scenes.json` and give it sources in `config/sources.json` (RSS feed, Google News query, subreddit).
- Bluesky: add `{ "handle": "someone.bsky.social", "scene": "cs2" }` entries to `bluesky.accounts` in `config/sources.json`.

Run the check locally any time with `npm install && npm run check`.

## Notes

- GitHub can delay scheduled runs by several minutes when it's busy, so "every 5 minutes" is really "every 5 to 15."
- The keepalive workflow re-enables the schedule monthly so GitHub doesn't switch it off for inactivity.
- Logs of public repos are public. The bot only logs public headlines; secrets are never printed.

MIT licensed.

## Other channels (Rivals Report, Tag Assist)

The same watcher also runs for two more channels, each with its own config folder, memory and feed folder, so BBN's files never change:

| Channel | Config | Feed files (on the `feed` branch) |
|---|---|---|
| Rivals Report (Marvel Rivals) | `config/channels/rivals/` | `rivals/alerts.json`, `rivals/rundown.json`, `rivals/health.json` |
| Tag Assist (Marvel Tōkon) | `config/channels/tokon/` | `tokon/alerts.json`, `tokon/rundown.json`, `tokon/results.json` (start.gg), `tokon/health.json` |

They run inside the `watch` workflow after BBN's feed is published, with `continue-on-error`, and never post to Discord. `health.json` (hourly) lists every source and whether it returned data. Test one locally with `CONFIG_DIR=config/channels/rivals node src/index.js --check`.
