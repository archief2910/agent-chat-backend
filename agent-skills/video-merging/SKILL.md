---
name: video-merging
description: How to order clips and choose none, fade, or dissolve when merging videos.
---

Use merge_videos when the user wants two or more videos joined into one.

- video_urls must contain 2 to 100 http(s) URLs.
- Keep the array in the playback order the user asked for. Do not sort it.
- transition is none, fade, or dissolve. Use none unless the user asked for a transition.
- Render the video_url from the tool result. Do not invent a download link.
