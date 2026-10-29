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

## Daily rundown

The **rundown** workflow posts one message with every story from the last 24 hours, grouped by scene and ranked, plus which scenes were quiet. It runs daily at 17:47 UTC and any time you hit **Actions → rundown → Run workflow**. To send it to a different channel, add a second webhook as the secret `DISCORD_RUNDOWN_WEBHOOK_URL`.

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
