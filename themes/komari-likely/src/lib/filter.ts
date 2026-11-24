/**
 * The filter a list is shown by, given what the address asked for.
 *
 * A filter is one of the pills on offer: a group, a region while region
 * grouping is on, the expiring one while something expires. Anything else in
 * the address names no pill -- a bookmark or a shared link to a group since
 * renamed or removed, a country picked before region grouping was switched
 * off, 「即将到期」 once nothing does. Filtering by it emptied the list, and an
 * empty list rendered as 「还没有服务器…添加第一台服务器」 with a summary of
 * 0 / 0: a site with servers, reading as one without any. Such a filter is
 * dropped, and the page shows every machine with 「全部」 marked, as though the
 * address carried none.
 */
export function appliedFilter(requested: string, offered: (name: string) => boolean): string {
  return requested && offered(requested) ? requested : ""
}
