import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isHostedImageUrl, publicHttpsUrl } from "../src/lib/mediaUrl.js";

describe("public image URLs", () => {
  it("upgrades WordPress http GUIDs to https", () => {
    assert.equal(
      publicHttpsUrl("http://iceunderwater.co.za/wp-content/uploads/2026/09/a.jpg"),
      "https://iceunderwater.co.za/wp-content/uploads/2026/09/a.jpg",
    );
  });

  it("leaves https and empty values alone", () => {
    assert.equal(publicHttpsUrl("https://iceunderwater.co.za/x.jpg"), "https://iceunderwater.co.za/x.jpg");
    assert.equal(publicHttpsUrl(""), "");
    assert.equal(publicHttpsUrl(null), "");
  });

  it("rejects local paths as hosted URLs", () => {
    assert.equal(isHostedImageUrl("file:///data/user/0/x.jpg"), false);
    assert.equal(isHostedImageUrl("/var/mobile/x.jpg"), false);
    assert.equal(isHostedImageUrl("https://iceunderwater.co.za/x.jpg"), true);
  });
});
