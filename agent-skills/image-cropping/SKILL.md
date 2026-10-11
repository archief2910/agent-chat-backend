---
name: image-cropping
description: How to choose a complete crop rectangle in percent, pixels, or crop coordinates.
---

Use crop_image only when the user wants part of an existing image removed or reframed.

Send image_url and exactly one complete rectangle:

- Percent: x_percent, y_percent, width_percent, and height_percent. Width and height must be greater than 0.
- Pixels: width_px and height_px. Include both x_px and y_px, or neither. If neither is set, the crop is centered.
- crop: an object with x, y, width, and height. Width and height must be at least 1.

Do not mix the three forms in one call. Do not invent the cropped URL; render the image_url from the tool result.
