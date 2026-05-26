import changelogMarkdown from "../../CHANGELOG.md?raw";
import packageJson from "../../package.json";

export type ReleaseChangeCategory = {
  title: string;
  items: string[];
};

export type ReleaseNote = {
  version: string;
  date?: string;
  categories: ReleaseChangeCategory[];
};

const CUSTOMER_VISIBLE_CATEGORY_TITLES = new Set([
  "新功能",
  "修复",
  "性能优化",
  "破坏性变更",
  "其他",
]);

export const appVersion = packageJson.version;
export const releaseNotes = parseChangelog(changelogMarkdown);

export function parseChangelog(markdown: string): ReleaseNote[] {
  const lines = markdown.split(/\r?\n/);
  const releases: ReleaseNote[] = [];
  let currentRelease: ReleaseNote | undefined;
  let currentCategory: ReleaseChangeCategory | undefined;

  for (const line of lines) {
    const releaseMatch = /^##\s+v?(\d+\.\d+\.\d+)(?:\s+-\s+(.+))?\s*$/.exec(line);

    if (releaseMatch) {
      currentRelease = {
        version: releaseMatch[1],
        date: releaseMatch[2]?.trim(),
        categories: [],
      };
      releases.push(currentRelease);
      currentCategory = undefined;
      continue;
    }

    if (!currentRelease) {
      continue;
    }

    const categoryMatch = /^###\s+(.+?)\s*$/.exec(line);

    if (categoryMatch) {
      const title = categoryMatch[1].trim();
      currentCategory = CUSTOMER_VISIBLE_CATEGORY_TITLES.has(title)
        ? { title, items: [] }
        : undefined;

      if (currentCategory) {
        currentRelease.categories.push(currentCategory);
      }
      continue;
    }

    const itemMatch = /^-\s+(.+?)\s*$/.exec(line);

    if (itemMatch && currentCategory) {
      currentCategory.items.push(stripCommitHash(itemMatch[1].trim()));
    }
  }

  return releases
    .map((release) => ({
      ...release,
      categories: release.categories.filter((category) => category.items.length > 0),
    }))
    .filter((release) => release.categories.length > 0);
}

function stripCommitHash(value: string): string {
  return value.replace(/（[0-9a-f]{7,40}）$/i, "");
}
