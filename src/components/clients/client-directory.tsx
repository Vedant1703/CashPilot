"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Search,
  Plus,
  Users,
  Building,
  Mail,
  Phone,
  FileText,
  Edit2,
  Trash2,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
} from "lucide-react";
import { ClientFormModal, type ClientItem } from "./client-form-modal";
import { ClientDeleteModal } from "./client-delete-modal";

interface ClientDirectoryProps {
  initialClients?: ClientItem[];
}

export function ClientDirectory({ initialClients }: ClientDirectoryProps) {
  const [clients, setClients] = useState<ClientItem[]>(initialClients || []);
  const [isLoading, setIsLoading] = useState(!initialClients);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  // Modals state
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<ClientItem | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletingClient, setDeletingClient] = useState<ClientItem | null>(null);

  // Success message feedback
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Race-condition guard for search responses
  const searchRequestIdRef = useRef(0);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchClients = useCallback(async (query: string = "") => {
    const currentRequestId = ++searchRequestIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const url = query.trim()
        ? `/api/clients?search=${encodeURIComponent(query.trim())}`
        : "/api/clients";

      const res = await fetch(url);
      const json = await res.json();

      // Guard: Ignore response if a newer search request has already been dispatched
      if (currentRequestId !== searchRequestIdRef.current) {
        return;
      }

      if (!res.ok || !json.success) {
        setError(json.error || "Failed to load clients.");
        return;
      }

      setClients(json.data || []);
      setActiveSearch(query);
    } catch {
      if (currentRequestId === searchRequestIdRef.current) {
        setError("Network error while loading clients. Please try again.");
      }
    } finally {
      if (currentRequestId === searchRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Initial fetch if initialClients not supplied
  useEffect(() => {
    if (initialClients) return;

    let ignore = false;
    const currentRequestId = ++searchRequestIdRef.current;

    async function loadInitialClients() {
      try {
        const res = await fetch("/api/clients");
        const json = await res.json();

        if (ignore || currentRequestId !== searchRequestIdRef.current) {
          return;
        }

        if (!res.ok || !json.success) {
          setError(json.error || "Failed to load clients.");
          return;
        }

        setClients(json.data || []);
        setActiveSearch("");
      } catch {
        if (!ignore && currentRequestId === searchRequestIdRef.current) {
          setError("Network error while loading clients. Please try again.");
        }
      } finally {
        if (!ignore && currentRequestId === searchRequestIdRef.current) {
          setIsLoading(false);
        }
      }
    }

    void loadInitialClients();

    return () => {
      ignore = true;
    };
  }, [initialClients]);

  // Debounced search effect
  const handleSearchChange = (val: string) => {
    setSearchQuery(val);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      fetchClients(val);
    }, 250);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      fetchClients(searchQuery);
    }
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    fetchClients("");
  };

  // Actions
  const handleOpenCreateModal = () => {
    setEditingClient(null);
    setFormModalOpen(true);
  };

  const handleOpenEditModal = (client: ClientItem) => {
    setEditingClient(client);
    setFormModalOpen(true);
  };

  const handleOpenDeleteModal = (client: ClientItem) => {
    setDeletingClient(client);
    setDeleteModalOpen(true);
  };

  const handleFormSuccess = (savedClient: ClientItem) => {
    setClients((prev) => {
      const idx = prev.findIndex((c) => c.id === savedClient.id);
      if (idx >= 0) {
        // Updated existing
        const next = [...prev];
        next[idx] = savedClient;
        return next;
      }
      // Newly created: insert in alphabetical order by name
      return [savedClient, ...prev].sort((a, b) => a.name.localeCompare(b.name));
    });

    setSuccessMessage(
      editingClient
        ? `Client "${savedClient.name}" updated successfully.`
        : `Client "${savedClient.name}" created successfully.`
    );
    setTimeout(() => setSuccessMessage(null), 4000);
  };

  const handleDeleteSuccess = (deletedId: string) => {
    setClients((prev) => prev.filter((c) => c.id !== deletedId));
    setSuccessMessage("Client deleted successfully.");
    setTimeout(() => setSuccessMessage(null), 4000);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-headline font-bold text-2xl sm:text-3xl text-[#12263F] tracking-tight">
              Clients
            </h1>
            <span
              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono font-medium bg-[#E8F5F1] text-[#0C7C61] border border-[#A3E5D4]"
              aria-label={`${clients.length} total clients`}
            >
              {clients.length}
            </span>
          </div>
          <p className="text-xs sm:text-sm text-[#5E718D] mt-1">
            Manage client profiles and recipient contact information for your workspace.
          </p>
        </div>

        <button
          type="button"
          onClick={handleOpenCreateModal}
          id="new-client-btn"
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#09634E] text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors touch-target focus-visible:ring-2 focus-visible:ring-[#0C7C61]"
        >
          <Plus className="w-4 h-4 stroke-[2.5]" aria-hidden="true" />
          <span>New Client</span>
        </button>
      </div>

      {/* Success Notification Banner */}
      {successMessage && (
        <div
          role="status"
          className="p-3.5 rounded-xl bg-[#E8F5F1] border border-[#A3E5D4] text-[#0C7C61] text-xs sm:text-sm flex items-center justify-between gap-2 animate-in fade-in duration-150"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{successMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMessage(null)}
            className="p-1 rounded-lg hover:bg-[#34C79F]/20 text-[#0C7C61]"
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      )}

      {/* Controls Bar: Search & Refresh */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 rounded-2xl bg-white border border-[#E3E8EF] p-3 sm:p-4 shadow-xs">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search
            className="w-4 h-4 text-[#5E718D] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search by client name, email, or company..."
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-[#E3E8EF] text-xs sm:text-sm bg-[#F6F5F1]/40 focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] focus:outline-hidden placeholder:text-[#8A9BA8] transition-colors"
            aria-label="Search clients"
          />
        </div>

        {/* Clear search or Refresh action */}
        <div className="flex items-center gap-2 justify-end">
          {searchQuery && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="text-xs text-[#5E718D] hover:text-[#12263F] px-2.5 py-1.5 rounded-lg hover:bg-[#F6F5F1] transition-colors font-medium"
            >
              Clear search
            </button>
          )}

          <button
            type="button"
            onClick={() => fetchClients(searchQuery)}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#E3E8EF] hover:bg-[#F6F5F1] text-xs text-[#5E718D] hover:text-[#12263F] font-medium transition-colors disabled:opacity-50"
            title="Refresh client list"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div
          role="alert"
          className="p-5 rounded-2xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs sm:text-sm flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left"
        >
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => fetchClients(searchQuery)}
            className="px-3 py-1.5 rounded-xl bg-white border border-[#FECDCA] text-[#B42318] text-xs font-semibold hover:bg-[#FEF3F2] transition-colors shadow-2xs"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {isLoading && (
        <div className="rounded-2xl bg-white border border-[#E3E8EF] divide-y divide-[#EEF2F6] overflow-hidden animate-pulse">
          <div className="p-4 bg-[#F6F5F1]/60 h-10" />
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="p-4 sm:p-5 flex items-center justify-between gap-4">
              <div className="space-y-2 flex-1">
                <div className="h-4 w-48 bg-[#E3E8EF] rounded" />
                <div className="h-3 w-64 bg-[#EEF2F6] rounded" />
              </div>
              <div className="h-8 w-20 bg-[#E3E8EF] rounded-xl" />
            </div>
          ))}
        </div>
      )}

      {/* Empty State: Zero Search Results */}
      {!isLoading && clients.length === 0 && activeSearch.trim().length > 0 && (
        <div className="rounded-2xl bg-white border border-[#E3E8EF] p-8 sm:p-12 text-center space-y-4 shadow-xs">
          <div className="w-12 h-12 rounded-2xl bg-[#F6F5F1] text-[#5E718D] flex items-center justify-center mx-auto">
            <Search className="w-6 h-6" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h3 className="font-semibold text-base text-[#12263F]">No matching clients found</h3>
            <p className="text-xs sm:text-sm text-[#5E718D] max-w-md mx-auto">
              No clients matched &ldquo;{activeSearch}&rdquo;. Check spelling or try a different search term.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClearSearch}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#E3E8EF] hover:bg-[#F6F5F1] text-xs font-semibold text-[#12263F] transition-colors"
          >
            Clear Search Filter
          </button>
        </div>
      )}

      {/* Empty State: Workspace Has Zero Clients */}
      {!isLoading && clients.length === 0 && !activeSearch.trim() && (
        <div className="rounded-2xl bg-white border border-[#E3E8EF] p-8 sm:p-12 text-center space-y-4 shadow-xs">
          <div className="w-12 h-12 rounded-2xl bg-[#E8F5F1] text-[#0C7C61] flex items-center justify-center mx-auto border border-[#A3E5D4]">
            <Users className="w-6 h-6 stroke-[2]" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h3 className="font-semibold text-base sm:text-lg text-[#12263F]">
              Your client roster is empty
            </h3>
            <p className="text-xs sm:text-sm text-[#5E718D] max-w-md mx-auto leading-relaxed">
              Add your first client with their billing email and company info to start drafting and sending invoices.
            </p>
          </div>
          <button
            type="button"
            onClick={handleOpenCreateModal}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#09634E] text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors touch-target"
          >
            <Plus className="w-4 h-4 stroke-[2.5]" aria-hidden="true" />
            <span>Add Your First Client</span>
          </button>
        </div>
      )}

      {/* Client List Content */}
      {!isLoading && clients.length > 0 && (
        <>
          {/* Desktop Table Layout (md and up) */}
          <div
            tabIndex={0}
            role="region"
            aria-labelledby="clients-table-caption"
            className="hidden md:block rounded-2xl bg-white border border-[#E3E8EF] shadow-xs overflow-x-auto"
          >
            <table className="w-full text-left border-collapse border-spacing-0">
              <caption id="clients-table-caption" className="sr-only">
                Workspace Client Directory
              </caption>

              <thead className="bg-[#F6F5F1] border-b border-[#E3E8EF] text-[11px] font-semibold text-[#5E718D] uppercase tracking-wider">
                <tr>
                  <th scope="col" className="py-3 px-5">
                    Client & Company
                  </th>
                  <th scope="col" className="py-3 px-5">
                    Email Address
                  </th>
                  <th scope="col" className="py-3 px-5">
                    Phone
                  </th>
                  <th scope="col" className="py-3 px-5">
                    Invoices
                  </th>
                  <th scope="col" className="py-3 px-5 text-right">
                    Actions
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-[#EEF2F6] text-xs">
                {clients.map((client) => {
                  const invCount = client._count?.invoices ?? 0;
                  return (
                    <tr key={client.id} className="hover:bg-[#F6F5F1]/40 transition-colors">
                      {/* Name & Company */}
                      <td className="py-3.5 px-5">
                        <div className="font-semibold text-sm text-[#12263F]">{client.name}</div>
                        {client.company && (
                          <div className="text-xs text-[#5E718D] flex items-center gap-1 mt-0.5">
                            <Building className="w-3.5 h-3.5 shrink-0 text-[#8A9BA8]" aria-hidden="true" />
                            <span>{client.company}</span>
                          </div>
                        )}
                        {client.notes && (
                          <div className="text-[11px] text-[#8A9BA8] italic truncate max-w-xs mt-0.5">
                            {client.notes}
                          </div>
                        )}
                      </td>

                      {/* Email */}
                      <td className="py-3.5 px-5">
                        <div className="font-mono text-xs text-[#12263F] flex items-center gap-1.5">
                          <Mail className="w-3.5 h-3.5 text-[#5E718D]" aria-hidden="true" />
                          <span>{client.email}</span>
                        </div>
                      </td>

                      {/* Phone */}
                      <td className="py-3.5 px-5">
                        {client.phone ? (
                          <div className="text-xs text-[#5E718D] flex items-center gap-1.5">
                            <Phone className="w-3.5 h-3.5 text-[#8A9BA8]" aria-hidden="true" />
                            <span>{client.phone}</span>
                          </div>
                        ) : (
                          <span className="text-[#8A9BA8]">—</span>
                        )}
                      </td>

                      {/* Invoices Count */}
                      <td className="py-3.5 px-5">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-medium ${
                            invCount > 0
                              ? "bg-[#E8F5F1] text-[#0C7C61] border border-[#A3E5D4]"
                              : "bg-[#F6F5F1] text-[#5E718D] border border-[#E3E8EF]"
                          }`}
                        >
                          <FileText className="w-3 h-3" aria-hidden="true" />
                          <span>
                            {`${invCount} ${invCount === 1 ? "invoice" : "invoices"}`}
                          </span>
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleOpenEditModal(client)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E3E8EF] hover:bg-[#F6F5F1] text-xs font-semibold text-[#5E718D] hover:text-[#12263F] transition-colors touch-target"
                            title={`Edit ${client.name}`}
                          >
                            <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Edit</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleOpenDeleteModal(client)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E3E8EF] hover:bg-[#FEF3F2] hover:border-[#FECDCA] hover:text-[#B42318] text-xs font-semibold text-[#5E718D] transition-colors touch-target"
                            title={`Delete ${client.name}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Delete</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Card Grid Layout (sm and down) */}
          <div className="md:hidden space-y-3">
            {clients.map((client) => {
              const invCount = client._count?.invoices ?? 0;
              return (
                <div
                  key={client.id}
                  className="rounded-2xl bg-white border border-[#E3E8EF] p-4 shadow-xs space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="font-semibold text-base text-[#12263F] leading-tight">
                        {client.name}
                      </h2>
                      {client.company && (
                        <div className="text-xs text-[#5E718D] flex items-center gap-1 mt-0.5">
                          <Building className="w-3.5 h-3.5 shrink-0 text-[#8A9BA8]" aria-hidden="true" />
                          <span>{client.company}</span>
                        </div>
                      )}
                    </div>

                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-medium shrink-0 ${
                        invCount > 0
                          ? "bg-[#E8F5F1] text-[#0C7C61] border border-[#A3E5D4]"
                          : "bg-[#F6F5F1] text-[#5E718D] border border-[#E3E8EF]"
                      }`}
                    >
                      <FileText className="w-3 h-3" aria-hidden="true" />
                      <span>{invCount}</span>
                    </span>
                  </div>

                  <div className="space-y-1.5 text-xs pt-1 border-t border-[#EEF2F6]">
                    <div className="font-mono text-[#12263F] flex items-center gap-1.5 truncate">
                      <Mail className="w-3.5 h-3.5 text-[#5E718D] shrink-0" aria-hidden="true" />
                      <span className="truncate">{client.email}</span>
                    </div>

                    {client.phone && (
                      <div className="text-[#5E718D] flex items-center gap-1.5">
                        <Phone className="w-3.5 h-3.5 text-[#8A9BA8] shrink-0" aria-hidden="true" />
                        <span>{client.phone}</span>
                      </div>
                    )}

                    {client.notes && (
                      <div className="text-[11px] text-[#8A9BA8] italic pt-0.5">
                        {client.notes}
                      </div>
                    )}
                  </div>

                  <div className="pt-2 border-t border-[#EEF2F6] flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => handleOpenEditModal(client)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-[#E3E8EF] hover:bg-[#F6F5F1] text-xs font-semibold text-[#12263F] touch-target"
                    >
                      <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenDeleteModal(client)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-[#E3E8EF] hover:bg-[#FEF3F2] hover:border-[#FECDCA] text-[#B42318] text-xs font-semibold touch-target"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Form Modal (Create / Edit) */}
      <ClientFormModal
        isOpen={formModalOpen}
        onClose={() => setFormModalOpen(false)}
        onSuccess={handleFormSuccess}
        initialClient={editingClient}
      />

      {/* Delete Confirmation Modal */}
      <ClientDeleteModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onDeleteSuccess={handleDeleteSuccess}
        client={deletingClient}
      />
    </div>
  );
}
