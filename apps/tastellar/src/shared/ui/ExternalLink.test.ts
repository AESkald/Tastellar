import { describe, expect, it } from "vitest";
import { isTrustedExternalUrl } from "./ExternalLink";

describe("isTrustedExternalUrl", () => {
  it("accepts provider HTTPS links", () => {
    for (const url of [
      "https://boosty.to/tastellar",
      "https://www.themoviedb.org/movie/1",
      "https://openlibrary.org/works/OL1W",
      "https://books.google.com/books?id=123",
      "https://www.igdb.com/games/example",
      "https://steamcommunity.com/dev/apiterms",
    ]) {
      expect(isTrustedExternalUrl(url)).toBe(true);
    }
  });

  it("rejects untrusted hosts and unsafe URL forms", () => {
    for (const url of [
      "http://boosty.to/tastellar",
      "https://boosty.to.attacker.example/",
      "https://boosty.to@attacker.example/",
      "https://boosty.to:444/",
      "file:///etc/passwd",
    ]) {
      expect(isTrustedExternalUrl(url)).toBe(false);
    }
  });
});
