import { beforeEach, describe, expect, it } from "vitest";
import { createEmptySession, LocalStorageSessionRepository } from "./session-repository";

describe("LocalStorageSessionRepository", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("saves, lists, duplicates, and removes sessions", () => {
    const repository = new LocalStorageSessionRepository(window.localStorage);
    const session = createEmptySession();

    repository.save(session);
    expect(repository.list()).toHaveLength(1);

    const duplicated = repository.duplicate(session.id);
    expect(duplicated?.title).toContain("副本");
    expect(repository.list()).toHaveLength(2);

    repository.remove(session.id);
    expect(repository.list()).toHaveLength(1);
    expect(repository.list()[0].id).toBe(duplicated?.id);
  });
});
