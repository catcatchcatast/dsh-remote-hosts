import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Breadcrumb rows for display: inside the home subtree the chain starts at a
 * localized Home crumb; outside it the full ancestry shows, the root labeled
 * by its own path.
 */
export function displayCrumbs(listing: DirectoryListing, homeLabel: string): DirectoryEntry[] {
  const homeIndex = listing.crumbs.findIndex(crumb => crumb.path === listing.home)
  if (homeIndex === -1) return listing.crumbs
  const tail = listing.crumbs.slice(homeIndex + 1)
  return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail]
}

/**
 * The physical parent reached by the toolbar's up action. Display crumbs may
 * intentionally collapse every ancestor above the Host home, but Up must keep
 * walking the Host filesystem until the actual platform root.
 */
export function directoryParentPath(listing: DirectoryListing): string | undefined {
  return listing.crumbs.at(-2)?.path
}
