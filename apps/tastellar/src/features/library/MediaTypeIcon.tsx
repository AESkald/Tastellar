import {
  BookOpen,
  Clapperboard,
  Circle,
  Diamond,
  Film,
  Gamepad2,
  Grid2X2,
  Hexagon,
  MessageCircle,
  MessagesSquare,
  Octagon,
  Pentagon,
  Shapes,
  Square,
  Star,
  Triangle,
  Tv,
  type LucideIcon,
} from "lucide-react";
import type { MediaTypeIconKey } from "../../shared/bridge/libraryTypes";
import { t } from "../../shared/ui/i18n";

export const mediaTypeIconChoices: Array<{
  key: MediaTypeIconKey;
  labelKey: string;
}> = [
  { key: "book-open", labelKey: "library.icon.book" },
  { key: "clapperboard", labelKey: "library.icon.animation" },
  { key: "gamepad-2", labelKey: "library.icon.game" },
  { key: "film", labelKey: "library.icon.film" },
  { key: "tv", labelKey: "library.icon.tv" },
  { key: "message-circle", labelKey: "library.icon.message" },
  { key: "messages-square", labelKey: "library.icon.comic" },
  { key: "shape-circle", labelKey: "library.icon.circle" },
  { key: "shape-square", labelKey: "library.icon.square" },
  { key: "shape-triangle", labelKey: "library.icon.triangle" },
  { key: "shape-diamond", labelKey: "library.icon.diamond" },
  { key: "shape-hexagon", labelKey: "library.icon.hexagon" },
  { key: "shape-pentagon", labelKey: "library.icon.pentagon" },
  { key: "shape-octagon", labelKey: "library.icon.octagon" },
  { key: "shape-star", labelKey: "library.icon.star" },
  { key: "shape-shapes", labelKey: "library.icon.shapes" },
  { key: "shape-grid", labelKey: "library.icon.grid" },
];

const iconByKey: Record<MediaTypeIconKey, LucideIcon> = {
  "book-open": BookOpen,
  clapperboard: Clapperboard,
  "gamepad-2": Gamepad2,
  film: Film,
  tv: Tv,
  "message-circle": MessageCircle,
  "messages-square": MessagesSquare,
  "shape-circle": Circle,
  "shape-square": Square,
  "shape-triangle": Triangle,
  "shape-diamond": Diamond,
  "shape-hexagon": Hexagon,
  "shape-pentagon": Pentagon,
  "shape-octagon": Octagon,
  "shape-star": Star,
  "shape-shapes": Shapes,
  "shape-grid": Grid2X2,
};

export function MediaTypeIcon({
  iconKey,
  size = 15,
  className,
}: {
  iconKey: MediaTypeIconKey | string | null | undefined;
  size?: number;
  className?: string;
}) {
  const Icon = iconKey && iconKey in iconByKey
    ? iconByKey[iconKey as MediaTypeIconKey]
    : Circle;
  return <Icon aria-hidden="true" size={size} className={className} />;
}

const defaultTypeNames: Record<string, { english: string; key: string }> = {
  literature: { english: "Literature", key: "library.type.literature" },
  anime: { english: "Animation", key: "library.type.animation" },
  games: { english: "Games", key: "library.type.games" },
  films: { english: "Films", key: "library.type.films" },
  "tv-series": { english: "TV series", key: "library.type.tvSeries" },
  comic: { english: "Comic", key: "library.type.comic" },
};

export function mediaTypeName(id: string, storedName: string) {
  const defaultName = defaultTypeNames[id];
  const isDefaultName =
    defaultName?.english === storedName || (id === "anime" && storedName === "Anime");
  return isDefaultName && defaultName ? t(defaultName.key) : storedName;
}

const defaultCriterionNames: Record<string, { english: string; key: string }> = {
  plot: { english: "Plot", key: "library.criterion.plot" },
  world: { english: "World", key: "library.criterion.world" },
  characters: { english: "Characters", key: "library.criterion.characters" },
  audiovisual: {
    english: "Audiovisual presentation",
    key: "library.criterion.audiovisual",
  },
  atmosphere: { english: "Atmosphere", key: "library.criterion.atmosphere" },
  gameplay: { english: "Gameplay", key: "library.criterion.gameplay" },
  direction: { english: "Direction", key: "library.criterion.direction" },
  acting: { english: "Acting", key: "library.criterion.acting" },
  animation: { english: "Animation", key: "library.criterion.animation" },
  "writing-style": {
    english: "Writing style",
    key: "library.criterion.writingStyle",
  },
  "ideas-message": {
    english: "Ideas/Message",
    key: "library.criterion.ideasMessage",
  },
};

export function criterionName(id: string, storedName: string) {
  const defaultName = defaultCriterionNames[id];
  return defaultName?.english === storedName ? t(defaultName.key) : storedName;
}
