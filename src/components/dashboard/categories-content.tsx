"use client";

import { type FormEvent, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { resolveErrorMessage } from "@/components/dashboard/dashboard-shared";
import { SectionShell } from "@/components/dashboard/section-shell";
import type { AppRouter } from "@/server/api/routers/_app";
import { trpc } from "@/trpc/react";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PersistedCategory = RouterOutputs["accounts"]["listCategories"][number];

type CategoryDraft = {
  name: string;
};

function createEmptyDraft(): CategoryDraft {
  return {
    name: "",
  };
}

export function CategoriesContent() {
  const utils = trpc.useUtils();
  const categoriesQuery = trpc.accounts.listCategories.useQuery();
  const createCategoryMutation = trpc.accounts.createCategory.useMutation();
  const updateCategoryMutation = trpc.accounts.updateCategory.useMutation();
  const deleteCategoryMutation = trpc.accounts.deleteCategory.useMutation();

  const [draft, setDraft] = useState<CategoryDraft>(() => createEmptyDraft());
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listSuccessMessage, setListSuccessMessage] = useState<string | null>(null);
  const [deletingCategoryId, setDeletingCategoryId] = useState<number | null>(null);

  const categories = useMemo<PersistedCategory[]>(
    () => [...(categoriesQuery.data ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    [categoriesQuery.data]
  );

  const isEditing = typeof editingCategoryId === "number";
  const isSaving = createCategoryMutation.isPending || updateCategoryMutation.isPending;
  const isMutating = isSaving || deleteCategoryMutation.isPending;
  const loadError = categoriesQuery.error
    ? resolveErrorMessage(categoriesQuery.error, "Failed to load categories.")
    : null;

  function resetEditor(): void {
    setDraft(createEmptyDraft());
    setEditingCategoryId(null);
    setFormError(null);
    setListSuccessMessage(null);
  }

  function startEditingCategory(category: PersistedCategory): void {
    setDraft({
      name: category.name,
    });
    setEditingCategoryId(category.id);
    setFormError(null);
    setListError(null);
    setListSuccessMessage(null);
  }

  async function refreshData(): Promise<void> {
    await Promise.all([
      categoriesQuery.refetch(),
      utils.accounts.listCategories.invalidate(),
      utils.accounts.listRules.invalidate(),
      utils.accounts.transactionsView.invalidate(),
    ]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSaving) {
      return;
    }

    const name = draft.name.trim();
    if (name.length === 0) {
      setFormError("Category name is required.");
      return;
    }

    setFormError(null);
    setListError(null);
    setListSuccessMessage(null);

    try {
      let successMessage = "";
      if (isEditing && typeof editingCategoryId === "number") {
        await updateCategoryMutation.mutateAsync({
          categoryId: editingCategoryId,
          name,
        });
        successMessage = `Category "${name}" updated.`;
      } else {
        await createCategoryMutation.mutateAsync({
          name,
        });
        successMessage = `Category "${name}" created.`;
      }

      await refreshData();
      resetEditor();
      setListSuccessMessage(successMessage);
    } catch (error) {
      setFormError(
        resolveErrorMessage(error, isEditing ? "Could not update category." : "Could not create category.")
      );
    }
  }

  async function handleDelete(category: PersistedCategory): Promise<void> {
    if (isMutating || deletingCategoryId === category.id) {
      return;
    }

    const confirmed = window.confirm(
      `Delete category "${category.name}"? Related rules and transactions will become uncategorized.`
    );
    if (!confirmed) {
      return;
    }

    setDeletingCategoryId(category.id);
    setListError(null);
    setListSuccessMessage(null);

    try {
      await deleteCategoryMutation.mutateAsync({
        categoryId: category.id,
      });

      if (editingCategoryId === category.id) {
        resetEditor();
      }

      await refreshData();
      setListSuccessMessage(`Category "${category.name}" deleted.`);
    } catch (error) {
      setListError(resolveErrorMessage(error, "Could not delete category."));
    } finally {
      setDeletingCategoryId(null);
    }
  }

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <SectionShell
        title="Categories"
        subtitle="Manage categories used by transaction actions and rule automation."
        action={
          <div className="space-y-2 text-right">
            <p className="font-mono text-xs text-muted">{categories.length} categories</p>
          </div>
        }
      >
        <div className="grid gap-5 xl:grid-cols-[1fr_0.95fr]">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-muted">Category List</h3>
              <button
                type="button"
                onClick={resetEditor}
                disabled={isMutating}
                className="rounded-full border border-ink-soft/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                New Category
              </button>
            </div>

            {loadError ? (
              <p className="rounded-2xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{loadError}</p>
            ) : null}
            {listError ? (
              <p className="rounded-2xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{listError}</p>
            ) : null}
            {listSuccessMessage ? (
              <p className="rounded-2xl border border-accent/30 bg-accent/10 p-3 text-sm text-accent">
                {listSuccessMessage}
              </p>
            ) : null}

            {categoriesQuery.isPending && categories.length === 0 ? (
              <div className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4 text-sm text-muted">
                Loading categories...
              </div>
            ) : null}

            {!categoriesQuery.isPending && categories.length === 0 ? (
              <div className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4 text-sm text-muted">
                No categories yet. Create one from the form.
              </div>
            ) : null}

            <ul className="space-y-3">
              {categories.map((category) => {
                const isActive = editingCategoryId === category.id;
                const isDeleting = deletingCategoryId === category.id;

                return (
                  <li key={category.id}>
                    <article
                      className={`rounded-2xl border p-4 transition ${
                        isActive
                          ? "border-accent/35 bg-accent/5 shadow-[0_14px_30px_-26px_rgba(6,115,166,0.8)]"
                          : "border-ink-soft/15 bg-surface/90"
                      }`}
                    >
                      <header className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-sm font-semibold text-foreground">{category.name}</p>
                          <span className="rounded-full border border-ink-soft/15 px-2 py-0.5 font-mono text-[11px] text-muted">
                            #{category.id}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              startEditingCategory(category);
                            }}
                            disabled={isMutating}
                            className="rounded-full border border-ink-soft/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void handleDelete(category);
                            }}
                            disabled={isDeleting || isMutating}
                            className="rounded-full border border-danger/30 bg-danger/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {isDeleting ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </header>
                    </article>
                  </li>
                );
              })}
            </ul>
          </div>

          <form
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
            className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4"
          >
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  {isEditing ? `Edit Category #${editingCategoryId}` : "Create Category"}
                </h3>
                <p className="mt-1 text-xs text-muted">
                  Categories are referenced by transactions and rules via database foreign keys.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <button
                    type="button"
                    onClick={resetEditor}
                    disabled={isMutating}
                    className="rounded-full border border-ink-soft/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Cancel
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={isSaving || !!loadError}
                  className="rounded-full border border-accent/35 bg-accent/10 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {isSaving ? "Saving..." : isEditing ? "Update Category" : "Create Category"}
                </button>
              </div>
            </div>

            {formError ? (
              <p className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {formError}
              </p>
            ) : null}

            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
              Category Name
              <input
                type="text"
                value={draft.name}
                onChange={(event) => {
                  setDraft({
                    name: event.target.value,
                  });
                }}
                maxLength={120}
                placeholder="e.g. Groceries"
                className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
              />
            </label>
          </form>
        </div>
      </SectionShell>
    </div>
  );
}
