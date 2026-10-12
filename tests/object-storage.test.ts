import { describe, expect, it } from "vitest";
import { objectKey, publicObjectUrl } from "@/server/uploads/object-storage";

describe("object storage", () => {
  it("builds a stable key and a public URL", () => {
    expect(objectKey("user_1", "abc", "file_1", "my cat.png")).toBe("uploads/user_1/abc/file_1-my_cat.png");
    expect(publicObjectUrl("https://files.example.com/", "uploads/user_1/abc/file_1-my_cat.png")).toBe(
      "https://files.example.com/uploads/user_1/abc/file_1-my_cat.png",
    );
  });
});
