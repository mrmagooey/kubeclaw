import type { FetchJson } from './search.js';

export interface ImageMetadata {
  repo: string;
  digest: string | null;
  labels: Record<string, string>;
  readme: string;
}

export async function fetchImageMetadata(
  repo: string,
  tag: string,
  fetchJson: FetchJson,
): Promise<ImageMetadata> {
  let digest: string | null = null;
  let readme = '';

  try {
    const tagInfo = (await fetchJson(
      `https://hub.docker.com/v2/repositories/${repo}/tags/${tag}`,
    )) as {
      images?: { digest?: string }[];
    };
    digest = tagInfo.images?.[0]?.digest ?? null;
  } catch {
    /* tolerate */
  }

  try {
    const repoInfo = (await fetchJson(
      `https://hub.docker.com/v2/repositories/${repo}`,
    )) as {
      full_description?: string;
      description?: string;
    };
    readme = repoInfo.full_description ?? repoInfo.description ?? '';
  } catch {
    /* tolerate */
  }

  return { repo, digest, labels: {}, readme };
}
