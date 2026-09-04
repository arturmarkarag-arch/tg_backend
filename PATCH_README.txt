BASELINKER SERVER PATCH — MANUAL FILE REPLACEMENT
Date: 2026-09-04

This is NOT an installer/update package.
Copy the included files over the matching paths in the current server project.
New files/directories must be added as included.

Required server environment variable:
BASELINKER_API_TOKEN=<your BaseLinker API token>

Optional:
BASELINKER_API_URL=https://api.baselinker.com/connector.php
BASELINKER_TIMEOUT_MS=15000

Then restart the backend process.
Do NOT put the BaseLinker token into the client/Vite environment.
