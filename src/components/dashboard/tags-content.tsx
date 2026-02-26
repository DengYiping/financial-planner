"use client";

import { type FormEvent, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { ACCOUNT_COLORS, resolveErrorMessage } from "@/components/dashboard/dashboard-shared";
import { SectionShell } from "@/components/dashboard/section-shell";
import type { AppRouter } from "@/server/api/routers/_app";
import { trpc } from "@/trpc/react";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PersistedTag = RouterOutputs["accounts"]["listTags"][number];

const TAG_NAME_MAX_LENGTH = 120;

function tagAccent(tagId: number): string {
  return ACCOUNT_COLORS[(tagId - 1 + ACCOUNT_COLORS.length) % ACCOUNT_COLORS.length] ?? ACCOUNT_COLORS[0];
}

export function TagsContent() {
  const utils = trpc.useUtils();
  const tagsQuery = trpc.accounts.listTags.useQuery();
  const createTagMutation = trpc.accounts.createTag.useMutation();
  const updateTagMutation = trpc.accounts.updateTag.useMutation();
  const deleteTagMutation = trpc.accounts.deleteTag.useMutation();

  const [createName, setCreateName] = useState("");
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [listNotice, setListNotice] = useState<string | null>(null);
  const [deletingTagId, setDeletingTagId] = useState<number | null>(null);

  const tags = useMemo(() => {
    return [...(tagsQuery.data ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  }, [tagsQuery.data]);

  const isMutating = createTagMutation.isPending || updateTagMutation.isPending || deleteTagMutation.isPending;

  function startEditing(tag: PersistedTag): void {
    setEditingTagId(tag.id);
    setEditName(tag.name);
    setFormError(null);
    setListNotice(null);
  }

  function resetEditing(): void {
    setEditingTagId(null);
    setEditName("");
  }

  async function refreshTags(): Promise<void> {
    await Promise.all([
      tagsQuery.refetch(),
      utils.accounts.transactionsView.invalidate(),
      utils.accounts.listRules.invalidate(),
    ]);
  }

  async function handleCreateTag(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (createTagMutation.isPending) {
      return;
    }

    const normalizedName = createName.trim();
    if (normalizedName.length === 0) {
      setFormError("Tag name is required.");
      return;
    }
    if (normalizedName.length > TAG_NAME_MAX_LENGTH) {
      setFormError(`Tag name must be at most ${TAG_NAME_MAX_LENGTH} characters.`);
      return;
    }

    setFormError(null);
    setListNotice(null);
    try {
      await createTagMutation.mutateAsync({
        name: normalizedName,
      });
      await refreshTags();
      setCreateName("");
      setListNotice(`Created tag \"${normalizedName}\".`);
    } catch (error) {
      setFormError(resolveErrorMessage(error, "Could not create tag."));
    }
  }

  async function handleUpdateTag(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (editingTagId === null || updateTagMutation.isPending) {
      return;
    }

    const normalizedName = editName.trim();
    if (normalizedName.length === 0) {
      setFormError("Tag name is required.");
      return;
    }
    if (normalizedName.length > TAG_NAME_MAX_LENGTH) {
      setFormError(`Tag name must be at most ${TAG_NAME_MAX_LENGTH} characters.`);
      return;
    }

    setFormError(null);
    setListNotice(null);
    try {
      await updateTagMutation.mutateAsync({
        tagId: editingTagId,
        name: normalizedName,
      });
      await refreshTags();
      const updatedLabel = normalizedName;
      resetEditing();
      setListNotice(`Updated tag \"${updatedLabel}\".`);
    } catch (error) {
      setFormError(resolveErrorMessage(error, "Could not update tag."));
    }
  }

  async function handleDeleteTag(tag: PersistedTag): Promise<void> {
    if (deleteTagMutation.isPending || deletingTagId === tag.id) {
      return;
    }

    const confirmed = window.confirm(
      `Delete tag "${tag.name}"? This removes it from any transactions and rules that reference it.`
    );
    if (!confirmed) {
      return;
    }

    setDeletingTagId(tag.id);
    setFormError(null);
    setListNotice(null);
    try {
      await deleteTagMutation.mutateAsync({ tagId: tag.id });
      await refreshTags();
      if (editingTagId === tag.id) {
        resetEditing();
      }
      setListNotice(`Deleted tag \"${tag.name}\".`);
    } catch (error) {
      setFormError(resolveErrorMessage(error, "Could not delete tag."));
    } finally {
      setDeletingTagId(null);
    }
  }

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <SectionShell
        title="Tags"
        subtitle="Create and maintain reusable tags for transactions and rule actions."
        action={<p className="font-mono text-xs text-muted">{tags.length} tags</p>}
      >
        <div className="grid gap-5 xl:grid-cols-[minmax(280px,0.8fr)_1fr]">
          <form
            onSubmit={(event) => {
              void handleCreateTag(event);
            }}
            className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4"
          >
            <h3 className="text-base font-semibold text-foreground">Create Tag</h3>
            <p className="mt-1 text-xs text-muted">Tags can be assigned directly on transactions and in rule actions.</p>

            <label className="mt-4 flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
              Name
              <input
                type="text"
                value={createName}
                onChange={(event) => {
                  setCreateName(event.target.value);
                }}
                maxLength={TAG_NAME_MAX_LENGTH}
                placeholder="e.g. Travel"
                className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
              />
            </label>

            {formError ? (
              <p className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {formError}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={isMutating}
              className="mt-4 rounded-full border border-accent/35 bg-accent/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {createTagMutation.isPending ? "Creating..." : "Create Tag"}
            </button>
          </form>

          <div className="space-y-3">
            {tagsQuery.error ? (
              <p className="rounded-2xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                {resolveErrorMessage(tagsQuery.error, "Could not load tags.")}
              </p>
            ) : null}
            {listNotice ? (
              <p className="rounded-2xl border border-accent/30 bg-accent/10 p-3 text-sm text-accent">
                {listNotice}
              </p>
            ) : null}

            {tagsQuery.isPending ? (
              <div className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4 text-sm text-muted">
                Loading tags...
              </div>
            ) : null}

            {!tagsQuery.isPending && tags.length === 0 ? (
              <div className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4 text-sm text-muted">
                No tags yet. Create one to start tagging transactions and rules.
              </div>
            ) : null}

            <ul className="space-y-3">
              {tags.map((tag) => {
                const isEditing = editingTagId === tag.id;
                const isDeleting = deletingTagId === tag.id;
                const accent = tagAccent(tag.id);

                return (
                  <li key={tag.id}>
                    <article className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <span
                          className="inline-flex items-center gap-2 rounded-full border border-ink-soft/20 px-2.5 py-1 text-xs font-semibold"
                          style={{ color: accent }}
                        >
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accent }} aria-hidden />
                          {tag.name}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              startEditing(tag);
                            }}
                            disabled={isMutating}
                            className="rounded-full border border-ink-soft/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void handleDeleteTag(tag);
                            }}
                            disabled={isDeleting || isMutating}
                            className="rounded-full border border-danger/30 bg-danger/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {isDeleting ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </div>

                      {isEditing ? (
                        <form
                          className="flex flex-wrap items-center gap-2"
                          onSubmit={(event) => {
                            void handleUpdateTag(event);
                          }}
                        >
                          <input
                            type="text"
                            value={editName}
                            onChange={(event) => {
                              setEditName(event.target.value);
                            }}
                            maxLength={TAG_NAME_MAX_LENGTH}
                            className="min-w-[220px] flex-1 rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                          />
                          <button
                            type="submit"
                            disabled={updateTagMutation.isPending}
                            className="rounded-full border border-accent/35 bg-accent/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            {updateTagMutation.isPending ? "Saving..." : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={resetEditing}
                            disabled={updateTagMutation.isPending}
                            className="rounded-full border border-ink-soft/20 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            Cancel
                          </button>
                        </form>
                      ) : null}
                    </article>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </SectionShell>
    </div>
  );
}
