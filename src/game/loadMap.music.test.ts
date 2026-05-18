import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_URL, MAP_REGISTRY, MATCH_MUSIC_BY_MAP_URL, matchMusicUrlForMap } from "./loadMap";

describe("match music map coverage", () => {
  it("every shipped registry map has a BGM entry (beta sphere excluded)", () => {
    for (const m of MAP_REGISTRY) {
      if (m.id === "sphere_planet") {
        expect(matchMusicUrlForMap(m.url)).toBeNull();
        continue;
      }
      expect(MATCH_MUSIC_BY_MAP_URL[m.url], m.url).toBeDefined();
    }
  });

  it("matchMusicUrlForMap falls back for unknown paths", () => {
    expect(matchMusicUrlForMap("/maps/unknown.json")).toBe(MATCH_MUSIC_BY_MAP_URL[DEFAULT_MAP_URL]);
  });
});
