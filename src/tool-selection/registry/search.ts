export type FetchJson = (url: string) => Promise<unknown>;

export interface ImageCandidate {
  repo: string;
  description: string;
  stars: number;
  official: boolean;
}

export async function searchImages(
  keywords: string,
  fetchJson: FetchJson,
  limit = 10,
): Promise<ImageCandidate[]> {
  const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(keywords)}&page_size=${limit}`;
  let raw: unknown;
  try {
    raw = await fetchJson(url);
  } catch {
    return [];
  }
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const mapped: ImageCandidate[] = results
    .map((r) => {
      const o = r as Record<string, unknown>;
      if (typeof o.repo_name !== 'string') return null;
      return {
        repo: o.repo_name,
        description:
          typeof o.short_description === 'string' ? o.short_description : '',
        stars: typeof o.star_count === 'number' ? o.star_count : 0,
        official: o.is_official === true,
      };
    })
    .filter((x): x is ImageCandidate => x !== null);
  return mapped.sort(
    (a, b) => Number(b.official) - Number(a.official) || b.stars - a.stars,
  );
}
