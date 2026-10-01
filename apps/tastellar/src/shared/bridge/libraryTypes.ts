export type Disposition = "experienced" | "planned" | "dropped";
export type DatePrecision = "year" | "month" | "day";

export interface ReleaseDate {
  year: number;
  month?: number | null;
  day?: number | null;
  precision: DatePrecision;
}

export interface Entry {
  id: string;
  importOrder: number | null;
  version: number;
  title: string;
  disposition: Disposition;
  mediaTypeId: string | null;
  overallRating: number | null;
  coverAssetId: string | null;
  releaseDate: ReleaseDate | null;
  reviewText: string;
  shortLabel: string | null;
  criterionRatings: Record<string, number>;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type EntryDraft = Omit<
  Entry,
  "importOrder" | "version" | "createdAt" | "updatedAt"
> & {
  criterionRatings: Record<string, number | null>;
};

export interface MediaType {
  id: string;
  name: string;
  sortOrder: number;
  iconKey: MediaTypeIconKey;
  criterionIds: string[];
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type MediaTypeDraft = Omit<
  MediaType,
  "archivedAt" | "version" | "createdAt" | "updatedAt"
>;

export type MediaTypeIconKey =
  | "book-open"
  | "clapperboard"
  | "gamepad-2"
  | "film"
  | "tv"
  | "message-circle"
  | "messages-square"
  | "shape-circle"
  | "shape-square"
  | "shape-triangle"
  | "shape-diamond"
  | "shape-hexagon"
  | "shape-pentagon"
  | "shape-octagon"
  | "shape-star"
  | "shape-shapes"
  | "shape-grid";

export interface Criterion {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type CriterionDraft = Omit<
  Criterion,
  "archivedAt" | "version" | "createdAt" | "updatedAt"
>;

export interface Tag {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface LibraryState {
  revision: number;
  entries: Entry[];
  mediaTypes: MediaType[];
  criteria: Criterion[];
  tags: Tag[];
}
