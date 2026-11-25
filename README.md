# Study Together, Phones Down: prototype v0.5

A face-down focus timer for students. It works as a web page on a phone, and with this version it also records how people use it in a MongoDB database.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app (one page) |
| `api/track.js` | Small server function that receives usage data and writes it to MongoDB |
| `lib/ingest.js` | Checks and cleans the incoming data before it is saved |
| `package.json` | Tells the host to install the MongoDB driver |

The page and the API are hosted together on **Vercel**. The page sends data to `/api/track`, and the function writes it to **MongoDB Atlas**. Browsers cannot talk to MongoDB directly: the Atlas Data API that used to allow this was shut down on 30 September 2025, so a small server function is needed in between.

## What is tracked

Nothing is recorded until the user agrees in the **Help our study?** dialog, which appears on first launch. The choice can be changed at any time with the **Usage data** button on the home screen.

Each phone gets a random ID (a UUID kept in the browser), shown under **My sessions** as the *participant ID*. Typed text (names, room codes) is never sent inside events. The first name is stored once, on the user document, so survey and interview answers can be matched to app data.

### Collection `users`: one document per phone

| Field | Meaning |
| --- | --- |
| `_id` | Random user ID (participant ID) |
| `name` | First name typed in the app |
| `platform` | iOS, Android, computer or other |
| `appVersion`, `firstAppVersion` | Current and first app version seen |
| `createdAt`, `lastSeenAt` | First and latest contact |
| `batches`, `eventCount` | How many uploads and events so far |

### Collection `events`: one document per action

| Field | Meaning |
| --- | --- |
| `_id` | `userId:eventId`, so an event sent twice is stored once |
| `userId` | Who |
| `type` | What happened (see below) |
| `screen` | Screen the user was on |
| `target`, `label` | For clicks: button ID and its text |
| `props` | Extra details, for example `focus_session`, `focused_sec`, `pickups` |
| `clientTs`, `receivedAt` | Time on the phone and time the server received it |
| `appSessionId` | Groups events from one opening of the app |
| `demo`, `testSpeed` | Flags to remove demo and fast-clock test runs from the analysis |

Event types:

- **App use:** `consent_given`, `app_open`, `app_hidden`, `app_visible`, `screen_view`, `click`
- **Focus sessions:** `session_created`, `ready`, `face_down_start`, `face_down_resume`, `pickup`, `pickup_motion` (face-down but held in the hand), `left_app`, `screen_off_while_down`, `back_in_app`, `completed`, `stopped_early`
- **Sensor test:** `sensor_test_result`

### Collection `sessions`: one document per focus session

These are the same columns as the CSV export: `planned_min`, `focused_min`, `pickups`, `pickups_per_hour`, `longest_uninterrupted_min`, `avg_uninterrupted_min`, `focus_stretches`, `ended_early`, `penalty`, `self_rating`, `sensor`, `test_speed`, `app_version`, start and end time, plus `userId`. The document is updated when the user adds their rating.

## Setup

### 1. MongoDB Atlas (database)

1. Create a free account at mongodb.com/atlas and create a **free cluster**. Choose a European region.
2. **Database Access:** add a database user with a password, with read and write rights.
3. **Network Access:** add `0.0.0.0/0` (allow access from anywhere). Vercel's servers use changing IP addresses, so they cannot be listed one by one.
4. **Connect → Drivers:** copy the connection string (`mongodb+srv://…`) and put your password in it.

### 2. Vercel (hosting)

1. Put these files in the GitHub repository, keeping the `api` and `lib` folders.
2. Sign in to vercel.com with GitHub. Choose **Add New → Project** and import the repository. Framework preset: **Other**. No build command is needed.
3. Under **Environment Variables**, add:
   - `MONGODB_URI`: the connection string from Atlas (required)
   - `STATS_KEY`: any secret word, to see document counts (optional)
   - `MONGODB_DB`: database name (optional, default `focus_app`)
4. Deploy. The app is now at `https://<project>.vercel.app`; share this address instead of the GitHub Pages one.

### 3. Check that it works

- Open `https://<project>.vercel.app/api/track`. It should show `{"ok":true,"database":"connected"}`.
- Open the app on a phone, accept the dialog, and tap around.
- Open `https://<project>.vercel.app/api/track?key=<STATS_KEY>` to see the counts, or look in Atlas under **Browse Collections → focus_app**.

**Never put the connection string in the code or in GitHub.** It only goes into Vercel's environment variables.

### Keeping the page on GitHub Pages

If the page must stay on GitHub Pages, set `TRACK_ENDPOINT` near the top of `index.html` to `https://<project>.vercel.app/api/track`. Then set `ALLOWED_ORIGINS=https://<user>.github.io` in Vercel.

## Options

- Add `?track=0` to the address to turn tracking off for a demo or test.
- `?demo=1` (buttons instead of sensors) and `?speed=N` (faster clock) still work. Data from these runs is flagged in the `demo` and `testSpeed` fields.

## Useful queries (Atlas → Collections, or mongosh)

Real sessions only (no demo, normal clock):

```js
db.sessions.find({ demo: false, test_speed: 1 })
```

Average uninterrupted focus and pick-ups per hour, per person:

```js
db.sessions.aggregate([
  { $match: { demo: false, test_speed: 1 } },
  { $group: { _id: "$userId", sessions: { $sum: 1 },
      avg_uninterrupted_min: { $avg: "$avg_uninterrupted_min" },
      pickups_per_hour: { $avg: "$pickups_per_hour" },
      rating: { $avg: "$self_rating" } } }
])
```

Most tapped buttons:

```js
db.events.aggregate([
  { $match: { type: "click" } },
  { $group: { _id: "$target", taps: { $sum: 1 } } },
  { $sort: { taps: -1 } }
])
```

## Deleting someone's data

When a participant asks (they send the ID from **My sessions**):

```js
db.events.deleteMany({ userId: "<id>" })
db.sessions.deleteMany({ userId: "<id>" })
db.users.deleteOne({ _id: "<id>" })
```

## Notes

- If the phone is offline or the server is down, events wait on the phone (up to 500) and are sent later.
- When the page is closed, the remaining events are sent once more. The server ignores repeats.
- Group sessions still use a free public test server for live updates, separate from this database.
