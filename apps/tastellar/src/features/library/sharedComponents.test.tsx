import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LibraryDetailsPanel } from "./LibraryDetailsPanel";
import {
  createEmptyLibraryEntry,
  LibraryEntryEditor,
} from "./LibraryEntryEditor";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryWorkDetails } from "./LibraryWorkDetails";
import type { Entry, LibraryState } from "../../shared/bridge/libraryTypes";

describe("shared Library components", () => {
  it("renders the same add, search, and selectable navigation contract", () => {
    const markup = renderToStaticMarkup(
      createElement(LibrarySidebar, {
        ariaLabel: "Ranking media",
        searchId: "ranking-search",
        searchValue: "titan",
        onSearchChange: () => undefined,
        onAddWork: () => undefined,
        heading: "Media",
        count: 12,
        items: [
          {
            id: "score:10",
            label: "10",
            count: 3,
            selected: true,
            onSelect: () => undefined,
            buttonProps: { "data-ranking-drop-score": 10 },
          },
          {
            id: "unrated",
            label: "Unrated",
            count: 2,
            separatorBefore: true,
            onSelect: () => undefined,
          },
        ],
        footer: createElement(
          "button",
          { className: "library-sidebar-action" },
          "Manage types and tags",
        ),
      }),
    );

    expect(markup).toContain("library-add");
    expect(markup).toContain("library-search-field");
    expect(markup).toContain('id="ranking-search"');
    expect(markup).toContain("library-group-list");
    expect(markup).toContain('data-ranking-drop-score="10"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("library-sidebar-action");
  });

  it("keeps the full Add Work form available from either page", () => {
    const entry = createEmptyLibraryEntry();
    const state: LibraryState = {
      revision: 1,
      entries: [],
      mediaTypes: [],
      criteria: [],
      tags: [],
    };
    const markup = renderToStaticMarkup(
      createElement(LibraryEntryEditor, {
        entry,
        state,
        isNew: true,
        busy: false,
        error: "",
        hasCoverStorage: true,
        onCancel: () => undefined,
        onSave: () => undefined,
        onCreateTag: async () => {
          throw new Error("unused");
        },
      }),
    );

    expect(entry.disposition).toBe("planned");
    expect(markup).toContain("Add work");
    expect(markup).toContain("Media type");
    expect(markup).toContain("Overall rating");
    expect(markup).toContain("Release date");
    expect(markup).toContain("Tags");
    expect(markup).toContain("Cover");
    expect(markup).toContain("Your thoughts");
  });

  it("shares the Library details frame and actual rank/review content", () => {
    const entry: Entry = {
      ...createEmptyLibraryEntry(),
      id: "work-1",
      title: "A Work",
      disposition: "experienced",
      overallRating: 8,
      reviewText: "A memorable story.",
      tagIds: ["tag-1"],
      criterionRatings: {},
    };
    const state: LibraryState = {
      revision: 1,
      entries: [entry],
      mediaTypes: [],
      criteria: [],
      tags: [
        {
          id: "tag-1",
          name: "Favorite",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          version: 1,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(
        LibraryDetailsPanel,
        {
          title: "Details",
          ariaLabel: "Work details",
          onClose: () => undefined,
          width: 320,
        },
        createElement(LibraryWorkDetails, {
          entry,
          state,
          rankIndex: {
            withinScore: new Map([[entry.id, 2]]),
            overall: new Map([[entry.id, 1]]),
            totalPlaced: 248,
          },
          coverUrl: null,
          onEdit: () => undefined,
          onDelete: () => undefined,
        }),
      ),
    );

    expect(markup).toContain("library-context-panel");
    expect(markup).toContain("A Work");
    expect(markup).toContain("Within score");
    expect(markup).toContain("#2");
    expect(markup).toContain("#1 of 248");
    expect(markup).toContain("0.4%");
    expect(markup).toContain("A memorable story.");
    expect(markup).toContain("Favorite");
  });
});
