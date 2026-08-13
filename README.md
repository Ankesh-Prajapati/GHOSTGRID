# GHOSTGRID - Live Cyber Threat Map

GhostGrid is a static, browser-based cyber threat map for portfolio and research use. It visualizes currently flagged attacker IPs from public threat intelligence sources, geolocates them in the browser, and displays live event animation, deduplicated threat activity, threat history, and source-IP investigation.

The project is designed for GitHub Pages: no backend, no database, no build step, and no private API credentials.

## Project Overview

GhostGrid presents a security-analyst dashboard with:

- A global world map
- Live source-to-target attack animation
- Deduplicated threat log
- Clickable map markers and threat rows
- Threat history for repeated activity
- Source-IP investigation using the current session dataset
- Top attacker, target, vector, and violation panels
- Session-based time filtering

## Features

- **Live attack animation:** route line, moving packet, target pulse, and fade per event
- **Threat deduplication:** groups repeated events by source IP, target, attack type, and vector
- **Threat history:** first seen, last seen, total events, target countries, attack vectors, and recent chronological events
- **IP investigation:** previous targets, vectors, countries involved, event count, and first/last seen for a selected source IP
- **CVE watch (CISA KEV):** the 10 most recently added entries from CISA's official Known Exploited Vulnerabilities catalog, pulled from CISA's own GitHub mirror — real, authoritative, actively-exploited CVEs, not a mock
- **Live / paused stream:** pause incoming UI events without generating or replaying fake history
- **Time filters:** `LIVE`, `30M`, `1H`, `6H`, `24H` over events collected in the current browser session
- **Static deployment:** works from GitHub Pages or any static HTTP server

## Screenshots

Add screenshots after deployment:

```text
assets/screenshots/dashboard.png
assets/screenshots/threat-detail.png
```

Suggested capture:

1. Run the app locally.
2. Wait for live feed status.
3. Capture the dashboard with several events and a selected threat.

## Technology Stack

- HTML5
- CSS3
- Vanilla JavaScript
- Canvas 2D for route animation
- SVG for the world basemap
- `d3-geo`
- `d3-array`
- `topojson-client`
- Embedded world topology data

## Architecture / Data Flow

```text
Public blacklist feed (ipsum)
        |
        v
Browser fetches flagged IPs
        |
        v
GeoJS batch geolocation
        |
        v
Raw event objects kept in memory
        |
        +--> Canvas map animation
        +--> Deduplicated threat groups
        +--> Source-IP activity index
        +--> Stats, timeline, log, detail panel
```

Raw events are preserved in memory for the current browser session. Deduplication and IP history are derived indexes; they do not overwrite or mutate the original event objects.

## Project Structure

```text
threatmap/
├── index.html
├── css/
│   └── style.css
├── assets/
│   └── ghost-logo.gif
├── js/
│   ├── app.js
│   ├── data.js
│   ├── d3-array.min.js
│   ├── d3-geo.min.js
│   ├── geo.js
│   ├── map.js
│   ├── topojson-client.min.js
│   └── world-data.js
├── .env.example
├── .gitignore
└── README.md
```

## Installation

No package installation is required for normal use.

Clone the repository:

```bash
git clone https://github.com/Ankesh-Prajapati/<repo-name>.git
cd <repo-name>
```

## Configuration

The current implementation uses public, keyless, CORS-enabled endpoints directly from the browser. Configuration is documented in `.env.example`, but the static app does not load `.env` files at runtime.

To change public data endpoints, edit `js/data.js`.

## Environment Variables

No private environment variables are required.

`.env.example` documents the public URLs used by the project:

- `GHOSTGRID_IPSUM_PRIMARY_URL`
- `GHOSTGRID_IPSUM_FALLBACK_URL`
- `GHOSTGRID_GEOJS_BATCH_URL`
- `GHOSTGRID_LOCAL_PORT`

Do not commit `.env`, credentials, private keys, or local secrets.

## Running Locally

Serve the folder over HTTP. Opening `index.html` directly with `file://` can break browser `fetch()` behavior.

```bash
python -m http.server 8080
```

Open:

```text
http://localhost:8080
```

## GitHub Pages Deployment

This project is static and does not need a build step.

1. Push the project to a GitHub repository.
2. Open repository **Settings**.
3. Go to **Pages**.
4. Set **Source** to `Deploy from a branch`.
5. Select the `main` branch and `/ (root)`.
6. Save.

The relative asset paths in `index.html` work on GitHub Pages project sites.

## API/Data Source

GhostGrid currently consumes public, open data sources:

- [`stamparm/ipsum`](https://github.com/stamparm/ipsum): aggregated public blacklist of flagged IPs
- [`geojs.io`](https://www.geojs.io/): public GeoIP lookup used for approximate attacker geolocation

No private API credentials are required.

Important data note:

- Source IPs and source geolocation are based on public threat intelligence and GeoIP lookup.
- Target locations, attack-vector labels, and violation labels are visualization fields in the current implementation because the public feed does not provide real victim telemetry.
- Deduplication and IP investigation use only the events available in the current browser session.

## Security & Privacy

- No backend server is used.
- No private credentials are required.
- No visitor data is intentionally collected by this project.
- All API requests are made from the visitor's browser to public endpoints.
- Do not commit `.env`, private keys, logs, or credentials.

## Limitations

- Browser-only session history; refresh clears in-memory events.
- No persistent database or long-term analytics.
- GeoIP accuracy depends on the public GeoJS response.
- Public threat feeds can be unavailable, rate-limited, or blocked by browser/network policy.
- The public blacklist does not include real victim/target telemetry.

## Roadmap

- Optional persisted local session history
- Export selected threat/IP activity as JSON
- Configurable public feed list
- Accessibility pass for keyboard navigation and reduced motion
- Optional screenshot assets for README and GitHub Pages

## Contributing

Contributions are welcome. Keep changes small, readable, and aligned with the static no-backend architecture.

Before opening a pull request:

```bash
node --check js/app.js
node --check js/map.js
node --check js/data.js
node --check js/geo.js
```

## License

This project is released under the MIT License. See `LICENSE` for details.
