---
name: image-generation
description: When to generate a new image or edit an existing one, and how to write the prompt.
---

Use gpt_image_2 when the user wants a new image or a change to an image they already provided.

- New image: call gpt_image_2 with a prompt and no uploadedImages. The text-to-image mode is selected for you.
- Edit: call gpt_image_2 with a prompt and uploadedImages containing the source image URL. The edit mode is selected for you.
- Keep prompts specific about subject, composition, and what must stay unchanged on an edit.
- Do not invent the result URL. Wait for the tool result and show that image.

Prefer a preset size unless the user asked for exact dimensions.
