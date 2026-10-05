import { describe, expect, it } from "vitest";
import { makeProviderCredentialInput } from "./ProviderCredentials";

describe("provider credential form payloads", () => {
  it("requires both IGDB application fields and trims their values", () => {
    expect(
      makeProviderCredentialInput("igdb", {
        clientId: "  fixture-client-id  ",
        clientSecret: "   ",
      }),
    ).toBeNull();
    expect(
      makeProviderCredentialInput("igdb", {
        clientId: " fixture-client-id ",
        clientSecret: " fixture-client-secret ",
      }),
    ).toEqual({
      provider: "igdb",
      clientId: "fixture-client-id",
      clientSecret: "fixture-client-secret",
    });
  });

  it("sends Steam API credentials separately from the user's import profile", () => {
    expect(
      makeProviderCredentialInput("steam", { apiKey: " fixture-steam-key " }),
    ).toEqual({ provider: "steam", apiKey: "fixture-steam-key" });
  });

  it("accepts TMDb bearer tokens and Google Books keys without saving empty values", () => {
    expect(
      makeProviderCredentialInput("tmdb", { apiKey: " fixture-tmdb-token " }),
    ).toEqual({ provider: "tmdb", apiKey: "fixture-tmdb-token" });
    expect(
      makeProviderCredentialInput("googleBooks", { apiKey: " " }),
    ).toBeNull();
  });
});
