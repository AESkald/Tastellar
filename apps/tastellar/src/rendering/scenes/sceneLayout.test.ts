import { describe, expect, it } from "vitest";
import {
  buildSceneLayout,
  isScaleTransition,
  selectLabelWorkIds,
  type UniverseProjection,
  type UniverseWork,
} from "./sceneLayout";

function work(
  id: string,
  rank: number | null,
  extra: Partial<UniverseWork> = {},
): UniverseWork {
  return { id, title: `Work ${id}`, rank, ...extra };
}

function properSegmentsCross(
  first: Array<[number, number, number]>,
  second: Array<[number, number, number]>,
) {
  const [a, b] = first;
  const [c, d] = second;
  const orient = (p: number[], q: number[], r: number[]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  return abC * abD < -1e-8 && cdA * cdB < -1e-8;
}

describe("universe scene layout", () => {
  it("keeps the full-group #1 sun when filters hide it", () => {
    const first = work("first", 1);
    const second = work("second", 2);
    const projection: UniverseProjection = {
      group: "10",
      works: [first, second],
      visibleIds: new Set([second.id]),
    };

    const layout = buildSceneLayout(projection);
    const sun = layout.objects.find(
      (object) => object.kind === "sun" && object.id === first.id,
    );
    const hiddenCenter = layout.objects.find(
      (object) => object.kind === "sun" && object.id === undefined,
    );
    const secondPlanet = layout.objects.find(
      (object) => object.id === second.id,
    );
    const filteredLayout = buildSceneLayout({
      ...projection,
      visibleIds: new Set([second.id]),
    });
    const filteredSecond = filteredLayout.objects.find(
      (object) => object.id === second.id,
    );

    expect(sun).toMatchObject({ id: first.id, x: 0, y: 0, z: 0 });
    expect(hiddenCenter).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(secondPlanet?.kind).toBe("planet");
    expect(secondPlanet).not.toMatchObject({ x: 0, y: 0, z: 0 });
    expect(filteredSecond).toMatchObject({
      x: secondPlanet?.x,
      y: secondPlanet?.y,
      z: secondPlanet?.z,
    });
  });

  it("uses canonical display order for an all-unranked solar centerpiece without inventing a rank", () => {
    const later = work("later", null, { displayOrder: 1 });
    const first = work("first-unranked", null, { displayOrder: 0 });
    const layout = buildSceneLayout({ group: "10", works: [later, first] });
    const center = layout.objects.find((object) => object.id === first.id);
    const orbiting = layout.objects.find((object) => object.id === later.id);

    expect(center).toMatchObject({ kind: "sun", x: 0, y: 0, z: 0 });
    expect(center?.work?.rank).toBeNull();
    expect(orbiting?.kind).toBe("planet");
    expect(orbiting?.orbitRadius).toBe(1.3);
  });

  it("uses small equal planets on expanding circular solar orbits", () => {
    const works = Array.from({ length: 9 }, (_, index) =>
      work(`solar-${index + 1}`, index + 1),
    );
    const layout = buildSceneLayout({ group: "10", works });
    const rankOne = layout.objects.find((object) => object.work?.rank === 1)!;
    const planets = layout.objects.filter((object) => object.kind === "planet");

    expect(rankOne).toMatchObject({ kind: "sun", alpha: 1 });
    expect(planets.every((planet) => planet.size === planets[0].size)).toBe(true);
    expect(rankOne.size).toBeGreaterThan(planets[0].size);
    expect(planets.every((planet) => planet.orbitYScale === 0)).toBe(true);
    const radii = planets.map((planet) => planet.orbitRadius ?? 0);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(new Set(radii).size).toBe(radii.length);
    expect(layout.defaultPitch).toBeCloseTo(0.5);
    expect(layout.lines).toHaveLength(0);
    for (const planet of planets)
      expect(Math.hypot(planet.x, planet.z)).toBeCloseTo(planet.orbitRadius ?? 0, 8);
  });

  it("keeps default constellation links in one plane without crossing", () => {
    const works = Array.from({ length: 48 }, (_, index) =>
      work(`constellation-${index}`, (index % 16) + 1, {
        mediaTypeId: `type-${index % 4}`,
      }),
    );
    const layout = buildSceneLayout({ group: "9", works });

    expect(layout.defaultPitch).toBeLessThan(0.1);
    const constellationDepths = layout.objects.filter((object) => object.id).map(({ z }) => Math.abs(z));
    expect(Math.max(...constellationDepths)).toBeGreaterThan(0.4);
    expect(Math.max(...constellationDepths)).toBeLessThanOrEqual(0.8);
    for (let first = 0; first < layout.lines.length; first += 1) {
      for (let second = first + 1; second < layout.lines.length; second += 1) {
        expect(properSegmentsCross(layout.lines[first].points, layout.lines[second].points)).toBe(false);
      }
    }
  });

  it("uses viewport aspect for deterministic constellation spread and camera fit", () => {
    const works = Array.from({ length: 18 }, (_, index) =>
      work(`responsive-${index}`, (index % 18) + 1, { mediaTypeId: `type-${index % 6}` }),
    );
    const landscape = buildSceneLayout({ group: "9", works, viewportAspect: 3.5 });
    const landscapeRepeat = buildSceneLayout({ group: "9", works, viewportWidth: 1400, viewportHeight: 400 });
    const portrait = buildSceneLayout({ group: "9", works, viewportAspect: 0.65 });
    const span = (layout: ReturnType<typeof buildSceneLayout>, axis: "x" | "y") => {
      const values = layout.objects.filter((object) => object.id).map((object) => object[axis]);
      return Math.max(...values) - Math.min(...values);
    };

    expect(landscape.objects).toEqual(landscapeRepeat.objects);
    expect(landscape.cameraDistance).toBe(landscapeRepeat.cameraDistance);
    expect(span(landscape, "x")).toBeGreaterThan(span(portrait, "x"));
    expect(span(landscape, "y")).toBeLessThan(span(portrait, "y"));
    const workObjects = landscape.objects.filter((object) => object.work);
    const portraitWorkObjects = portrait.objects.filter((object) => object.work);
    expect(workObjects.every(({ size }) => Number.isFinite(size) && size > 0 && size <= 1)).toBe(true);
    expect(workObjects.map(({ size }) => size)).toEqual(portraitWorkObjects.map(({ size }) => size));
    const landscapeById = new Map(workObjects.map((object) => [object.id, object]));
    expect(landscapeById.get("responsive-0")!.alpha).toBeGreaterThan(landscapeById.get("responsive-17")!.alpha);
    expect(landscape.lines.every(({ alpha }) => Number.isFinite(alpha) && alpha > 0 && alpha <= 1)).toBe(true);
    expect(landscape.lines.map(({ alpha }) => alpha)).toEqual(portrait.lines.map(({ alpha }) => alpha));

    const expectWorksFitViewport = (layout: ReturnType<typeof buildSceneLayout>, aspect: number) => {
      const halfViewHeight = layout.cameraDistance * Math.tan(Math.PI / 6);
      const halfViewWidth = halfViewHeight * aspect;
      expect(layout.objects.filter((object) => object.work).every(({ x, y, size }) =>
        Math.abs(x) + size <= halfViewWidth && Math.abs(y) + size <= halfViewHeight,
      )).toBe(true);
    };
    expectWorksFitViewport(landscape, 3.5);
    expectWorksFitViewport(portrait, 0.65);
  });

  it("spreads the shared low-rating asteroid lane across its full width without object collisions", () => {
    const works = Array.from({ length: 124 }, (_, index) =>
      work(`low-${index}`, (index % 5) + 1, { rating: 1 + (index % 6) }),
    );
    const layout = buildSceneLayout({ group: "6", works });
    const asteroids = layout.objects.filter((object) => object.id);
    const byX = [...asteroids].sort((a, b) => a.x - b.x);
    const expectedStep = 24 / (asteroids.length - 1);

    expect(asteroids).toHaveLength(124);
    expect(Math.min(...asteroids.map(({ x }) => x))).toBeCloseTo(-12, 8);
    expect(Math.max(...asteroids.map(({ x }) => x))).toBeCloseTo(12, 8);
    expect(new Set(asteroids.map(({ driftX }) => driftX)).size).toBeGreaterThan(1);
    expect(asteroids.every(({ driftX }) => (driftX ?? 0) > 0)).toBe(true);
    for (let index = 1; index < byX.length; index += 1)
      expect(byX[index].x - byX[index - 1].x).toBeCloseTo(expectedStep, 8);
    const byY = [...asteroids].sort((a, b) => a.y - b.y);
    for (let index = 0; index < byY.length; index += 1) {
      expect(byY[index].color).toBe("#858b93");
      if (index > 0)
        expect(byY[index].y - byY[index - 1].y).toBeGreaterThan(
          (byY[index].size + byY[index - 1].size) / 2,
        );
    }
  });

  it("gives zero-based planned works distinct, repeatable positions", () => {
    const projection: UniverseProjection = {
      group: "planned",
      works: [
        work("planned-0", null, { displayOrder: 0 }),
        work("planned-1", null, { displayOrder: 1 }),
      ],
    };

    const first = buildSceneLayout(projection);
    const repeat = buildSceneLayout(projection);
    const position = (id: string) => {
      const object = first.objects.find((item) => item.id === id)!;
      return [object.x, object.y, object.z];
    };

    expect(position("planned-0")).not.toEqual(position("planned-1"));
    expect(repeat.objects).toEqual(first.objects);
  });

  it.each([200, 2_000])(
    "keeps a %i-work layout finite and label selection bounded with selection retained",
    (count) => {
      const works = Array.from({ length: count }, (_, index) =>
        work(`work-${index}`, index + 1),
      );
      const layout = buildSceneLayout({ group: "7", works });
      const selectedId = works.at(-1)!.id;
      const labels = selectLabelWorkIds(works, selectedId, 72);

      expect(layout.objects).toHaveLength(count);
      expect(
        new Set(
          layout.objects
            .map((object) => object.id)
            .filter((id): id is string => id !== undefined),
        ),
      ).toEqual(new Set(works.map(({ id }) => id)));
      expect(
        layout.objects.every(({ x, y, z, size }) =>
          [x, y, z, size].every(Number.isFinite),
        ),
      ).toBe(true);
      expect(labels.size).toBe(Math.min(72, count));
      expect(labels.has(selectedId)).toBe(true);
      expect(labels.has(works[0].id)).toBe(true);
    },
  );

  it("makes higher-canonical-rank deep-field galaxies brighter without changing across filters", () => {
    const works = [work("brightest", 1), work("middle", 50), work("faintest", 100)];
    const full = buildSceneLayout({ group: "7", works });
    const filtered = buildSceneLayout({
      group: "7",
      works,
      visibleIds: new Set(["brightest", "faintest"]),
    });
    const objectById = (layout: ReturnType<typeof buildSceneLayout>, id: string) =>
      layout.objects.find((object) => object.id === id)!;

    expect(full.objects.every((object) => object.id !== undefined && object.kind === "galaxy")).toBe(true);
    expect(objectById(full, "brightest").alpha).toBe(1);
    expect(objectById(full, "middle").alpha).toBeGreaterThan(objectById(full, "faintest").alpha);
    expect(objectById(full, "faintest").alpha).toBeGreaterThan(0);
    expect(objectById(full, "faintest").alpha).toBeLessThan(1);
    for (const id of ["brightest", "faintest"]) {
      expect(objectById(filtered, id).alpha).toBe(objectById(full, id).alpha);
      expect(objectById(filtered, id).size).toBe(objectById(full, id).size);
      expect([objectById(filtered, id).x, objectById(filtered, id).y]).toEqual([
        objectById(full, id).x,
        objectById(full, id).y,
      ]);
    }
  });

  it("has no invalid coordinates and gives every work a selectable object in each scene", () => {
    const groups = [
      "10",
      "9",
      "8",
      "7",
      "6",
      "1",
      "planned",
      "dropped",
      "unrated",
    ] as const;
    const works = [work("best", 1), work("next", 2), work("unplaced", null)];

    for (const group of groups) {
      const layout = buildSceneLayout({ group, works });
      const selectableIds = layout.objects
        .map((object) => object.id)
        .filter((id): id is string => id !== undefined);

      expect(new Set(selectableIds)).toEqual(
        new Set(works.map(({ id }) => id)),
      );
      expect(
        layout.objects.every(({ x, y, z, size }) =>
          [x, y, z, size].every(Number.isFinite),
        ),
      ).toBe(true);
    }
  });

  it("provides distinct scale groups and transitions between any two high tiers", () => {
    for (const group of [
      "10",
      "9",
      "8",
      "7",
      "6",
      "planned",
      "dropped",
      "unrated",
    ] as const) {
      expect(buildSceneLayout({ group, works: [] }).group).toBe(group);
    }
    expect(isScaleTransition("10", "9")).toBe(true);
    expect(isScaleTransition("9", "8")).toBe(true);
    expect(isScaleTransition("8", "7")).toBe(true);
    expect(isScaleTransition("10", "8")).toBe(true);
    expect(isScaleTransition("10", "7")).toBe(true);
    expect(isScaleTransition("7", "10")).toBe(true);
    expect(isScaleTransition("10", "10")).toBe(false);
    expect(isScaleTransition("7", "6")).toBe(false);
    expect(isScaleTransition("planned", "dropped")).toBe(false);
  });
});
