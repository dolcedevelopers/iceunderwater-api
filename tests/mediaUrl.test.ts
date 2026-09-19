import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isHostedImageUrl, pickSrcsetUrl, publicHttpsUrl, toCatalogImageUrl } from "../src/lib/mediaUrl.js";

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

  it("rewrites uploads to a medium catalog derivative", () => {
    assert.equal(
      toCatalogImageUrl("https://iceunderwater.co.za/wp-content/uploads/2026/09/product.jpg"),
      "https://iceunderwater.co.za/wp-content/uploads/2026/09/product-medium.jpg",
    );
    assert.equal(
      toCatalogImageUrl("https://iceunderwater.co.za/wp-content/uploads/2026/09/product-150x150.jpg"),
      "https://iceunderwater.co.za/wp-content/uploads/2026/09/product-150x150.jpg",
    );
  });

  it("picks the closest srcset width for catalog cards", () => {
    const srcset =
      "https://iceunderwater.co.za/wp-content/uploads/2026/09/product.jpg 527w, https://iceunderwater.co.za/wp-content/uploads/2026/09/product-medium.jpg 300w, https://iceunderwater.co.za/wp-content/uploads/2026/09/product-150x150.jpg 150w";
    assert.equal(
      pickSrcsetUrl(srcset, 300),
      "https://iceunderwater.co.za/wp-content/uploads/2026/09/product-medium.jpg",
    );
    assert.equal(
      pickSrcsetUrl(srcset, 400),
      "https://iceunderwater.co.za/wp-content/uploads/2026/09/product.jpg",
    );
  });
});
