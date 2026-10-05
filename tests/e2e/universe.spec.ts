import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";

type Work = {
  title: string;
  disposition: "planned" | "experienced" | "dropped";
  score?: string;
};

type UniverseTransitionSample = {
  elapsedMs: number;
  labelCount: number;
  allLabelsInert: boolean;
  labelPresent: boolean;
  opacity: number | null;
  ariaHidden: string | null;
  tabIndex: number | null;
  pointerEvents: string | null;
  sceneLabel: string | null;
  cameraGroup: string | null;
};

type UniverseTransitionTrace = {
  navigationAt: number | null;
  samples: UniverseTransitionSample[];
};

async function startUniverseTransitionTrace(page: Page, workId: string) {
  await page.evaluate((targetWorkId) => {
    type Trace = {
      startedAt: number;
      navigationAt: number | null;
      stopped: boolean;
      observer: MutationObserver | null;
      animationFrame: number | null;
      samples: UniverseTransitionSample[];
    };
    const host = window as typeof window & { __universeTransitionTrace?: Trace };
    const trace: Trace = { startedAt: performance.now(), navigationAt: null, stopped: false, observer: null, animationFrame: null, samples: [] };
    host.__universeTransitionTrace = trace;
    const capture = () => {
      if (trace.stopped) return;
      const scene = document.querySelector<HTMLElement>('[data-testid="library-universe"]');
      if (!scene) return;
      const labels = [...scene.querySelectorAll<HTMLElement>('[data-testid="universe-work"]')];
      const label = labels
        .find((candidate) => candidate.getAttribute("data-work-id") === targetWorkId || candidate.getAttribute("aria-label") === targetWorkId);
      trace.samples.push({
        elapsedMs: performance.now() - trace.startedAt,
        labelCount: labels.length,
        allLabelsInert: labels.every((candidate) =>
          Number(candidate.getAttribute("data-label-opacity")) === 0
          && candidate.getAttribute("aria-hidden") === "true"
          && candidate.tabIndex === -1
          && getComputedStyle(candidate).pointerEvents === "none"),
        labelPresent: Boolean(label),
        opacity: label ? Number(label.getAttribute("data-label-opacity")) : null,
        ariaHidden: label?.getAttribute("aria-hidden") ?? null,
        tabIndex: label?.tabIndex ?? null,
        pointerEvents: label ? getComputedStyle(label).pointerEvents : null,
        sceneLabel: scene.getAttribute("aria-label"),
        cameraGroup: scene.getAttribute("data-camera-group"),
      });
    };
    const frameSample = () => {
      trace.animationFrame = null;
      if (trace.stopped) return;
      capture();
      if (trace.samples.length < 2000) trace.animationFrame = requestAnimationFrame(frameSample);
    };
    trace.observer = new MutationObserver(capture);
    trace.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-hidden", "class", "data-camera-group", "data-label-opacity", "data-testid", "data-work-id", "style", "tabindex"],
    });
    document.addEventListener("click", (event) => {
      if ((event.target as Element | null)?.closest(".library-group-navigation button")) trace.navigationAt = performance.now() - trace.startedAt;
    }, { capture: true, once: true });
    capture();
    trace.animationFrame = requestAnimationFrame(frameSample);
  }, workId);
}

async function stopUniverseTransitionTrace(page: Page) {
  return page.evaluate(() => {
    const host = window as typeof window & {
      __universeTransitionTrace?: { stopped: boolean; observer: MutationObserver | null; animationFrame: number | null; navigationAt: number | null; samples: UniverseTransitionSample[] };
    };
    const trace = host.__universeTransitionTrace;
    if (!trace) throw new Error("Universe transition trace was not started");
    trace.stopped = true;
    trace.observer?.disconnect();
    if (trace.animationFrame !== null) cancelAnimationFrame(trace.animationFrame);
    trace.animationFrame = null;
    return { navigationAt: trace.navigationAt, samples: trace.samples };
  });
}

function expectUniverseTravelTrace(
  trace: UniverseTransitionTrace,
  targetGroup: string,
  sourceGroup: string,
  expectFadeInAfterTravel = false,
) {
  const targetSceneSamples = trace.samples.filter((sample) => sample.sceneLabel?.endsWith(`for ${targetGroup}`));
  expect(targetSceneSamples.length, `observed destination scene ${targetGroup}`).toBeGreaterThan(0);
  expect(trace.navigationAt, `observed the browser navigation click for ${sourceGroup}→${targetGroup}`).toBeTruthy();
  const handoff = targetSceneSamples.find((sample) => sample.cameraGroup === targetGroup);
  expect(handoff, `renderer hands the camera to group ${targetGroup}`).toBeTruthy();
  expect(handoff!.elapsedMs).toBeGreaterThan(trace.navigationAt!);
  const firstVisibleSample = targetSceneSamples.find((sample) => sample.opacity !== null && sample.opacity > 0);
  const travelEndAt = firstVisibleSample?.elapsedMs ?? handoff!.elapsedMs;
  const travelSamples = targetSceneSamples.filter((sample) => sample.elapsedMs < travelEndAt);
  expect(travelSamples.length, `captured destination scene during ${sourceGroup}→${targetGroup} travel`).toBeGreaterThan(0);
  for (const sample of travelSamples) {
    expect(sample.labelCount === 0 || sample.allLabelsInert, "titles are absent or transparent and inert during scale travel").toBe(true);
    if (sample.labelPresent) {
      expect(sample.opacity).toBe(0);
      expect(sample.ariaHidden).toBe("true");
      expect(sample.tabIndex).toBe(-1);
      expect(sample.pointerEvents).toBe("none");
    }
  }
  expect(travelSamples.some((sample) => sample.cameraGroup === sourceGroup)).toBe(true);
  if (expectFadeInAfterTravel) {
    expect(firstVisibleSample, `destination labels fade in after ${sourceGroup}→${targetGroup} travel`).toBeTruthy();
    expect(firstVisibleSample!.elapsedMs - trace.navigationAt!).toBeGreaterThanOrEqual(850);
  }
}

function decodePng(png: Buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const imageData: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8 || ![2, 6].includes(colorType)) throw new Error("Unexpected screenshot PNG format");
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") imageData.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(imageData));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[input++];
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[input++];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const above = y > 0 ? pixels[row - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[row - stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const base = left + above - upperLeft;
        const leftDistance = Math.abs(base - left);
        const aboveDistance = Math.abs(base - above);
        const upperLeftDistance = Math.abs(base - upperLeft);
        predictor = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
          ? left
          : aboveDistance <= upperLeftDistance ? above : upperLeft;
      } else if (filter !== 0) throw new Error(`Unexpected PNG row filter ${filter}`);
      pixels[row + x] = (value + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

async function chooseOption(page: Page, within: Locator, label: string, option: string) {
  await within.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function addWork(page: Page, work: Work) {
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill(work.title);
  await chooseOption(page, editor, "Media type", "Animation");
  await chooseOption(page, editor, "Disposition", {
    planned: "Plan to Watch",
    experienced: "Already experienced",
    dropped: "Dropped",
  }[work.disposition]);
  if (work.score) await chooseOption(page, editor, "Overall rating", `${work.score} / 10`);
  await editor.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(editor).toHaveCount(0);
}

async function openGroup(page: Page, label: string) {
  await page.locator(".library-group-list")
    .getByRole("button", { name: new RegExp(`^${label}(?:\\s|$)`) })
    .click();
  await expect(page.locator(".library-heading-copy h1")).toHaveText(label);
}

const syntheticTierCounts = [
  { score: 10, count: 4, label: "Solar" },
  { score: 9, count: 18, label: "Constellation" },
  { score: 8, count: 71, label: "Galaxy" },
  { score: 7, count: 124, label: "Deep Field" },
] as const;

function buildSyntheticUniverseState() {
  const now = "2026-10-05T00:00:00Z";
  const entries = syntheticTierCounts.flatMap(({ score, count, label }) =>
    Array.from({ length: count }, (_, index) => ({
      id: `synthetic-universe-${score}-${index + 1}`,
      version: 1,
      title: `Synthetic ${label} Work ${index + 1}`,
      disposition: "experienced",
      mediaTypeId: "anime",
      overallRating: score,
      coverAssetId: null,
      releaseDate: null,
      reviewText: "",
      shortLabel: null,
      criterionRatings: {},
      tagIds: [],
      externalIdentities: [],
      remoteCover: null,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const rankedEntries = entries.map((entry) => ({
    entryId: entry.id,
    score: entry.overallRating,
    placed: true,
  }));
  const mediaTypes = [{
    id: "anime",
    name: "Animation",
    iconKey: "clapperboard",
    sortOrder: 0,
    criterionIds: [],
    archivedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }];
  const library = { revision: 0, entries, mediaTypes, criteria: [], tags: [] };
  const tiers = Array.from({ length: 10 }, (_, index) => ({ score: 10 - index, inputSequence: 0 }));
  const tierOrders = tiers.map(({ score }) => [score, {
    placed: rankedEntries.filter((entry) => entry.score === score && entry.placed).map((entry) => entry.entryId),
    unplaced: rankedEntries.filter((entry) => entry.score === score && !entry.placed).map((entry) => entry.entryId),
  }]);
  return { library, rankedEntries, tierOrders, tiers };
}

async function seedSampleArchive(
  page: Page,
  subset?: { score: number; count: number; unranked?: boolean },
) {
  const state = buildSyntheticUniverseState();
  let library = state.library;
  let ranking = { entries: state.rankedEntries };
  if (subset) {
    const includedIds = new Set(
      library.entries
        .filter((entry) => entry.disposition === "experienced" && entry.overallRating === subset.score)
        .slice(0, subset.count)
        .map((entry) => entry.id),
    );
    if (includedIds.size !== subset.count) throw new Error("Synthetic universe tier has too few works for the requested sample");
    library = { ...library, entries: library.entries.filter((entry) => includedIds.has(entry.id)) };
    ranking = { ...ranking, entries: ranking.entries.filter((entry) => includedIds.has(entry.entryId)) };
    if (subset.unranked)
      ranking = { ...ranking, entries: ranking.entries.map((entry) => ({ ...entry, placed: false })) };
  }
  const tierOrders = state.tiers.map(({ score }) => [score, {
    placed: ranking.entries.filter((entry) => entry.score === score && entry.placed).map((entry) => entry.entryId),
    unplaced: ranking.entries.filter((entry) => entry.score === score && !entry.placed).map((entry) => entry.entryId),
  }]);
  await page.addInitScript(({ library, rankedEntries, orders, tiers }) => {
    sessionStorage.setItem("tastellar.preview.revision.v1", String(library.revision));
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify(library));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: rankedEntries.map((entry) => [entry.entryId, { score: entry.score, placed: entry.placed }]),
      tierOrders: orders,
      sequences: tiers.map((tier) => [tier.score, tier.inputSequence]),
      initialized: true,
      session: null,
      judgments: [],
      latestMove: null,
    }));
  }, { library, rankedEntries: ranking.entries, orders: tierOrders, tiers: state.tiers });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
}

test("only score groups 10–7 show a universe scene; other groups keep their lists", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  for (const [score, title] of [["10", "Solar favorite"], ["9", "Constellation favorite"], ["8", "Galaxy favorite"], ["7", "Deep field favorite"]])
    await addWork(page, { title, disposition: "experienced", score });
  await addWork(page, { title: "Low work six", disposition: "experienced", score: "6" });
  await addWork(page, { title: "Low work one", disposition: "experienced", score: "1" });
  await addWork(page, { title: "Future work", disposition: "planned" });
  await addWork(page, { title: "Dropped work", disposition: "dropped" });
  await addWork(page, { title: "Unrated work", disposition: "experienced" });

  const scene = page.getByTestId("library-universe");
  for (const score of ["10", "9", "8", "7"]) {
    await openGroup(page, score);
    await expect(scene).toBeVisible();
    await expect(scene).toHaveAttribute("aria-label", new RegExp(`scene for ${score}$`));
  }
  for (const group of ["6", "1", "Plan to Watch", "Dropped", "Unrated"]) {
    await openGroup(page, group);
    await expect(scene).toHaveCount(0);
    await expect(page.locator(".library-list-toolbar")).toBeVisible();
  }
  await openGroup(page, "6");
  await expect(page.getByText("Low work six", { exact: true }).first()).toBeVisible();
  await page.getByText("Low work six", { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Low work six", exact: true })).toBeVisible();
});

test("the 3D scenes preference removes and restores the scene window", async ({ page }) => {
  await seedSampleArchive(page, { score: 10, count: 2 });
  await openGroup(page, "10");
  const scene = page.getByTestId("library-universe");
  await expect(scene).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sceneSwitch = page.getByRole("switch", { name: "3D scenes", exact: true });
  await expect(sceneSwitch).toHaveAttribute("aria-checked", "true");
  await sceneSwitch.click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  for (const score of ["10", "9", "8", "7"]) {
    await openGroup(page, score);
    await expect(scene).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "3D scenes", exact: true }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await openGroup(page, "8");
  await expect(scene).toBeVisible();
});

test("the four high-score scenes navigate directly and scene selection opens details", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  for (const [score, title] of [["10", "Solar favorite"], ["9", "Constellation favorite"], ["8", "Galaxy favorite"], ["7", "Deep field favorite"]])
    await addWork(page, { title, disposition: "experienced", score });
  const scene = page.getByTestId("library-universe");
  await expect(scene).toHaveAttribute("data-motion-enabled", "true");
  const names: Record<string, string> = { "10": "Solar system", "9": "Constellations", "8": "Spiral galaxy", "7": "Deep field" };
  for (const score of ["10", "9", "8", "7"]) {
    await openGroup(page, score);
    await expect(scene).toHaveAttribute("aria-label", `${names[score]} scene for ${score}`);
    await expect(scene.locator(".universe-canvas-wrap")).toBeVisible();
    await scene.screenshot({ path: `test-results/universe-scale-${score}.png`, animations: "disabled" });
  }
  await openGroup(page, "10");
  await page.waitForTimeout(1000);
  const switcher = page.locator(".library-list-toolbar");
  await expect(switcher).toBeVisible();
  await expect(switcher.locator(".library-sort-control")).toBeVisible();
  await expect(scene.locator(".universe-tier-switch")).toHaveCount(0);
  const switcherBox = await switcher.boundingBox();
  const canvasBox = await scene.locator(".universe-canvas-wrap").boundingBox();
  if (!switcherBox || !canvasBox) throw new Error("Tier switch and scene stage should be measurable");
  expect(switcherBox.y + switcherBox.height).toBeLessThanOrEqual(canvasBox.y);
  await startUniverseTransitionTrace(page, "Constellation favorite");
  await switcher.getByRole("button", { name: "Next group", exact: true }).click();
  await expect(scene).toHaveAttribute("aria-label", `${names["9"]} scene for 9`);
  const travelLabel = scene.locator('[data-testid="universe-work"][aria-label="Constellation favorite"]');
  await expect.poll(async () => Number(await travelLabel.getAttribute("data-label-opacity")), { timeout: 3000, intervals: [16, 32, 64] }).toBeGreaterThan(0.9);
  const directTransitionTrace = await stopUniverseTransitionTrace(page);
  expectUniverseTravelTrace(directTransitionTrace, "9", "10", true);
  await openGroup(page, "9");
  await expect(scene.getByRole("button", { name: "Constellation favorite", exact: true })).toBeVisible();
  await scene.getByRole("button", { name: "Constellation favorite", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Constellation favorite", exact: true })).toBeVisible();
});

test("the 7↔8 scale transition hides titles for the full travel", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await seedSampleArchive(page);
  await openGroup(page, "8");
  const scene = page.getByTestId("library-universe");
  await expect(scene).toHaveAttribute("data-motion-enabled", "true");
  await expect(scene).toHaveAttribute("data-camera-group", "8");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    const groupNavigation = page.locator(".library-list-toolbar .library-group-navigation");
    await startUniverseTransitionTrace(page, "synthetic-universe-7-1");
    await groupNavigation.getByRole("button", { name: "Next group", exact: true }).click();
    await expect(scene).toHaveAttribute("aria-label", /Deep field scene for 7$/);
    const deepLabel = scene.locator('[data-testid="universe-work"][data-work-id="synthetic-universe-7-1"]');
    await expect(scene).toHaveAttribute("data-camera-group", "7", { timeout: 5000 });
    await expect.poll(async () => Number(await deepLabel.getAttribute("data-label-opacity")), { timeout: 5000 }).toBeGreaterThan(0.99);
    const forwardTrace = await stopUniverseTransitionTrace(page);
    expectUniverseTravelTrace(forwardTrace, "7", "8", true);
    await expect(scene).toHaveAttribute("data-camera-yaw", "0");
    await expect(scene).toHaveAttribute("data-camera-pitch", "0");

    await startUniverseTransitionTrace(page, "synthetic-universe-8-1");
    await groupNavigation.getByRole("button", { name: "Previous group", exact: true }).click();
    await expect(scene).toHaveAttribute("aria-label", /Spiral galaxy scene for 8$/);
    await expect(scene).toHaveAttribute("data-camera-group", "8", { timeout: 5000 });
    const reverseTrace = await stopUniverseTransitionTrace(page);
    expectUniverseTravelTrace(reverseTrace, "8", "7");
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }

  const canvas = scene.locator("canvas");
  const galaxyLabel = scene.locator('[data-testid="universe-work"][data-work-id="synthetic-universe-8-1"]');
  await expect(galaxyLabel).toHaveAttribute("data-label-opacity", "0");
  await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -600, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  });
  await expect.poll(async () => Number(await galaxyLabel.getAttribute("data-label-opacity")), { timeout: 1500 }).toBeGreaterThan(0.9);
  await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 6000, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  });
  await expect(galaxyLabel).toHaveAttribute("data-label-opacity", "0");
});

test("the highest-ranked solar work remains selectable through sun rendering and rotation", async ({ page }) => {
  await seedSampleArchive(page, { score: 10, count: 4 });
  await openGroup(page, "10");
  const scene = page.getByTestId("library-universe");
  const first = scene.locator('[data-testid="universe-work"][data-work-rank="1"]');
  await expect(first).toHaveCount(1);
  const title = await first.getAttribute("aria-label");
  if (!title) throw new Error("Rank one solar work needs an accessible title");
  await expect(first).toBeVisible();
  const viewport = scene.getByRole("region", { name: "Interactive universe scene" });
  await viewport.focus();
  const before = Number(await scene.getAttribute("data-camera-yaw"));
  await viewport.press("ArrowRight");
  await expect.poll(async () => Number(await scene.getAttribute("data-camera-yaw"))).not.toBe(before);
  await scene.screenshot({ path: "test-results/universe-solar-rotated-rank-one.png", animations: "disabled" });
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
});

test("galaxy labels fade at maximum zoom-out and return as the user zooms in", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await addWork(page, { title: "Fadeable galaxy work", disposition: "experienced", score: "8" });
  await openGroup(page, "8");
  const scene = page.getByTestId("library-universe");
  const label = scene.getByTestId("universe-work");
  await expect(label).toHaveAttribute("data-label-opacity", "0");
  const canvas = scene.locator("canvas");
  await canvas.evaluate((element) => {
    (window as Window & { __galaxyCanvas?: Element }).__galaxyCanvas = element;
  });
  await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -600, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  });
  await expect(label).not.toHaveAttribute("data-label-opacity", "0");
  await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 6000, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  });
  await expect(label).toHaveAttribute("data-label-opacity", "0");
  const coords = await label.evaluate((element) => ({
    x: Number(element.getAttribute("data-projected-x")),
    y: Number(element.getAttribute("data-projected-y")),
  }));
  const rect = await canvas.boundingBox();
  if (!rect) throw new Error("Galaxy canvas should be visible");
  await page.mouse.click(rect.x + coords.x, rect.y + coords.y);
  await expect(page.getByRole("heading", { name: "Fadeable galaxy work", exact: true })).toBeVisible();
});

test("the unranked 71-work galaxy shows its natural star arms at the fitted overview", async ({ page }) => {
  await seedSampleArchive(page, { score: 8, count: 71, unranked: true });
  await openGroup(page, "8");
  const scene = page.getByTestId("library-universe");
  await expect(scene).toHaveAttribute("data-renderer-status", "ready");
  await expect(scene.getByTestId("universe-work")).toHaveCount(71);
  expect(await scene.locator("canvas").evaluate((element) => (element as HTMLCanvasElement).getContext("webgl") !== null)).toBe(true);
  await page.waitForTimeout(1000);
  await scene.screenshot({ path: "test-results/universe-galaxy-71-overview.png", animations: "disabled" });
  const canvas = scene.locator("canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Galaxy canvas should be visible before rotating the scene");
  const yawBefore = Number(await scene.getAttribute("data-camera-yaw"));
  await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.58, bounds.y + bounds.height * 0.58, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await scene.getAttribute("data-camera-yaw"))).not.toBe(yawBefore);
  await page.waitForTimeout(350);
  await scene.screenshot({ path: "test-results/universe-galaxy-71-rotated.png", animations: "disabled" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Daylight/ }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await openGroup(page, "8");
  await page.waitForTimeout(250);
  await scene.screenshot({ path: "test-results/universe-galaxy-71-daylight.png", animations: "disabled" });
});

test("constellation stars remain visible against dark and light theme surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1580, height: 900 });
  await seedSampleArchive(page, { score: 9, count: 18 });
  await openGroup(page, "9");
  const scene = page.getByTestId("library-universe");
  await expect(scene).toHaveAttribute("data-renderer-status", "ready");
  await expect(scene.getByTestId("universe-work")).toHaveCount(18);
  expect(await scene.locator("canvas").evaluate((element) => (element as HTMLCanvasElement).getContext("webgl") !== null)).toBe(true);
  const stage = await scene.locator(".universe-canvas-wrap").boundingBox();
  if (!stage) throw new Error("Constellation stage should be measurable at a wide aspect");
  expect(stage.width / stage.height).toBeGreaterThan(3);
  await page.waitForTimeout(1000);
  await scene.screenshot({ path: "test-results/universe-constellations-dark.png", animations: "disabled" });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Daylight/ }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await openGroup(page, "9");
  await page.waitForTimeout(250);
  await scene.screenshot({ path: "test-results/universe-constellations-daylight.png", animations: "disabled" });
});

test("Deep Field has no environment starfield in the WebGL canvas", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await openGroup(page, "7");
  const scene = page.getByTestId("library-universe");
  await expect(scene).toHaveAttribute("data-renderer-status", "ready");
  await page.waitForTimeout(400);
  const canvas = scene.locator("canvas");
  expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).getContext("webgl") !== null)).toBe(true);
  const canvasBox = await canvas.boundingBox();
  const emptyStateBox = await scene.locator(".universe-empty-state").boundingBox();
  if (!canvasBox || !emptyStateBox) throw new Error("Expected an empty Deep Field canvas and its overlay");
  const canvasPng = await canvas.screenshot({ path: "test-results/universe-deep-field-empty-canvas.png" });
  const { width, height, channels, pixels } = decodePng(canvasPng);
  const colors = new Map<number, number>();
  for (let index = 0; index < width * height; index += 1) {
    const pixel = index * channels;
    const rgb = (pixels[pixel] << 16) | (pixels[pixel + 1] << 8) | pixels[pixel + 2];
    colors.set(rgb, (colors.get(rgb) ?? 0) + 1);
  }
  const background = [...colors.entries()].reduce((best, entry) => entry[1] > best[1] ? entry : best)[0];
  const backgroundRgb = [(background >> 16) & 255, (background >> 8) & 255, background & 255];
  let strayPixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const overlayLeft = emptyStateBox.x - canvasBox.x - 8;
    const overlayTop = emptyStateBox.y - canvasBox.y - 8;
    const overlayRight = overlayLeft + emptyStateBox.width + 16;
    const overlayBottom = overlayTop + emptyStateBox.height + 16;
    if (x >= overlayLeft && x <= overlayRight && y >= overlayTop && y <= overlayBottom) continue;
    const pixel = index * channels;
    const distance = Math.max(
      Math.abs(pixels[pixel] - backgroundRgb[0]),
      Math.abs(pixels[pixel + 1] - backgroundRgb[1]),
      Math.abs(pixels[pixel + 2] - backgroundRgb[2]),
    );
    if (distance > 48) strayPixels += 1;
  }
  expect(strayPixels).toBeLessThan(24);
});

test("Deep Field is a bounded 2D map with pan and zoom but no orbit", async ({ page }) => {
  await seedSampleArchive(page);
  const scene = page.getByTestId("library-universe");
  for (const score of ["10", "9", "8"]) {
    await openGroup(page, score);
    await expect(scene.locator(".universe-canvas-wrap")).toBeVisible();
    await page.waitForTimeout(1000);
    await scene.screenshot({ path: `test-results/universe-full-${score}.png`, animations: "disabled" });
  }
  await openGroup(page, "7");
  await page.waitForTimeout(1000);
  await expect(scene.getByRole("button", { name: "Pause scene motion", exact: true })).toHaveCount(0);
  await expect(scene.getByText(/Drag to pan|Drag to orbit/)).toHaveCount(0);
  await expect(scene.locator(".universe-canvas-wrap")).toHaveCSS("height", /3\d\dpx/);
  const labels = scene.getByTestId("universe-work");
  await expect(labels).toHaveCount(124);
  const initiallyVisible = await labels.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-work-id")));
  expect(initiallyVisible.length).toBe(124);
  await expect.poll(() => scene.getAttribute("data-camera-pan-x")).not.toBeNull();
  await expect.poll(() => scene.getAttribute("data-camera-pan-y")).not.toBeNull();
  await scene.screenshot({ path: "test-results/universe-deep-field-zoomed.png", animations: "disabled" });

  const camera = async () => {
    const [yaw, pitch, distance, panX, panY] = await Promise.all([
      "yaw", "pitch", "distance", "pan-x", "pan-y",
    ].map((key) => scene.getAttribute(`data-camera-${key}`)));
    if ([yaw, pitch, distance, panX, panY].some((value) => value === null)) throw new Error(`Deep Field camera state is unavailable: ${JSON.stringify({ yaw, pitch, distance, panX, panY })}`);
    return { yaw: Number(yaw), pitch: Number(pitch), distance: Number(distance), panX: Number(panX), panY: Number(panY) };
  };
  const before = await camera();
  const stage = await scene.locator("canvas").boundingBox();
  if (!stage) throw new Error("Deep Field canvas should be visible");
  const drag = async (dx: number, dy: number) => {
    const startX = stage.x + 12;
    const startY = stage.y + 12;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(220);
  };
  await drag(95, 45);
  const afterPan = await camera();
  expect(afterPan.panX !== before.panX || afterPan.panY !== before.panY).toBe(true);
  expect(afterPan.yaw).toBeCloseTo(before.yaw, 3);
  expect(afterPan.pitch).toBeCloseTo(before.pitch, 3);
  expect(Math.abs(afterPan.panX)).toBeLessThan(100);
  expect(Math.abs(afterPan.panY)).toBeLessThan(100);
  const afterPanIds = await labels.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-work-id")));
  expect(afterPanIds).toEqual(initiallyVisible);
  const initialPosition = await labels.first().getAttribute("data-projected-x");
  await drag(25, 12);
  expect(await labels.first().getAttribute("data-projected-x")).not.toBe(initialPosition);

  await page.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.5);
  await page.mouse.wheel(0, -420);
  await page.waitForTimeout(220);
  const afterZoom = await camera();
  expect(afterZoom.distance).toBeLessThan(afterPan.distance);
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(220);
  const maxZoomOut = await camera();
  expect(maxZoomOut.distance).toBeGreaterThan(afterZoom.distance);
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(100);
  expect((await camera()).distance).toBeCloseTo(maxZoomOut.distance, 2);
  expect(await labels.count()).toBe(124);
  expect(await scene.locator('[data-testid="universe-work"][data-selectable="true"]').count()).toBeLessThan(124);
  await drag(5000, 0);
  const edge = await camera();
  await drag(5000, 0);
  const clamped = await camera();
  expect(Math.abs(clamped.panX - edge.panX)).toBeLessThan(0.25);
  expect(await labels.count()).toBeGreaterThan(0);
  await scene.screenshot({ path: "test-results/universe-deep-field-pan-bound.png", animations: "disabled" });
});

test("scene size, theme contrast, starfield, and orbit controls remain usable", async ({ page }) => {
  await seedSampleArchive(page);
  await openGroup(page, "10");
  const scene = page.getByTestId("library-universe");
  const themeSnapshots = [
    ["Midnight", "dark", "rgb(28, 28, 35)"],
    ["Daylight", "light", "rgb(252, 251, 248)"],
    ["Dusk", "dusk", "rgb(42, 36, 52)"],
    ["Reading", "reading", "rgb(247, 242, 231)"],
  ];
  for (const [theme, dataTheme, background] of themeSnapshots) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(theme) }).click();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", dataTheme);
    expect(await scene.locator(".universe-canvas-wrap").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(background);
    await expect(scene.getByRole("button", { name: "Synthetic Solar Work 1", exact: true })).toBeVisible();
    await scene.screenshot({ path: `test-results/universe-${dataTheme}-solar.png`, animations: "disabled" });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(80);
  const canvas = scene.locator(".universe-canvas");
  const stillFrame = await canvas.screenshot();
  await page.waitForTimeout(160);
  const nextFrame = await canvas.screenshot();
  expect(createHash("sha256").update(nextFrame).digest("hex")).toBe(createHash("sha256").update(stillFrame).digest("hex"));

  const quality = scene.getByRole("combobox", { name: "Scene quality" });
  await quality.selectOption("off");
  await expect(scene.getByRole("status")).toContainText("Static view");
  await quality.selectOption("auto");
});

test("fallback rendering preserves selectable works", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const prototype = HTMLCanvasElement.prototype;
    const nativeGetContext = prototype.getContext as unknown as (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) => unknown;
    prototype.getContext = function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
      if (contextId.startsWith("webgl")) return null;
      return nativeGetContext.call(this, contextId, ...args);
    } as typeof prototype.getContext;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await addWork(page, { title: "Fallback remains a scene", disposition: "experienced", score: "10" });
  const scene = page.getByTestId("library-universe");
  await expect(scene.getByRole("status")).toContainText("3D unavailable");
  const work = scene.getByRole("button", { name: "Fallback remains a scene", exact: true });
  await work.click();
  await expect(page.getByRole("heading", { name: "Fallback remains a scene", exact: true })).toBeVisible();

  await addWork(page, { title: "Fallback galaxy work", disposition: "experienced", score: "8" });
  await addWork(page, { title: "Fallback deep-field work", disposition: "experienced", score: "7" });
  await openGroup(page, "8");
  await expect(scene.getByRole("status")).toContainText("3D unavailable");
  await page.waitForTimeout(1000);
  const startedAt = Date.now();
  await page.locator(".library-list-toolbar .library-group-navigation").getByRole("button", { name: "Next group", exact: true }).click();
  await expect(scene).toHaveAttribute("aria-label", /Deep field scene for 7$/);
  await page.waitForTimeout(Math.max(0, 650 - (Date.now() - startedAt)));
  const incoming = scene.getByTestId("universe-work");
  await expect(incoming).toHaveCount(1);
  await expect(incoming).toHaveAttribute("data-label-opacity", "0");
  await page.waitForTimeout(Math.max(0, 950 - (Date.now() - startedAt)));
  await expect.poll(async () => Number(await incoming.getAttribute("data-label-opacity")), { timeout: 2000 }).toBeGreaterThan(0.9);
});

test("all deep-field works remain in the list while only the current map window is rendered", async ({ page }) => {
  await seedSampleArchive(page);
  await openGroup(page, "7");
  const scene = page.getByTestId("library-universe");
  await expect(scene.locator(".universe-count")).toHaveText("124 works");
  const renderedLabels = scene.getByTestId("universe-work");
  expect(await renderedLabels.count()).toBeLessThan(124);
  await expect(page.locator(".library-work-card").first()).toBeVisible();
});
