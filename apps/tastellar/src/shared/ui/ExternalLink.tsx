import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

const trustedHosts = new Set([
  "boosty.to",
  "www.themoviedb.org",
  "openlibrary.org",
  "books.google.com",
  "developers.google.com",
  "www.igdb.com",
  "api-docs.igdb.com",
  "steamcommunity.com",
]);

export function isTrustedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      trustedHosts.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

type ExternalLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  href: string;
};

export function ExternalLink({ href, onClick, ...props }: ExternalLinkProps) {
  const safeHref = isTrustedExternalUrl(href) ? href : undefined;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (!safeHref) {
      event.preventDefault();
      return;
    }
    if (isTauri()) {
      event.preventDefault();
      void invoke("open_external_url", { url: safeHref }).catch(
        (error: unknown) => {
          console.error("Could not open the external link.", error);
        },
      );
    }
  };

  return (
    <a
      {...props}
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      aria-disabled={safeHref ? undefined : true}
    />
  );
}
