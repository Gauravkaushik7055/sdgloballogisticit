import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  Edit3,
  ListChecks,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useDropdowns } from '../../context/DropdownContext.tsx';
import { DropdownGroupKey, DropdownOptionItem, LocationItem } from '../../types/index.ts';
import { apiFetch } from '../../utils/api.ts';

interface GroupMeta {
  key: DropdownGroupKey;
  label: string;
}

export default function DropdownManagerView() {
  const { subscribeRealtime } = useAuth();
  const { refreshDropdowns, getOptions } = useDropdowns();
  const [viewMode, setViewMode] = useState<'dropdowns' | 'locations'>('dropdowns');

  const [groups, setGroups] = useState<GroupMeta[]>([]);
  const [optionsByGroup, setOptionsByGroup] = useState<Record<string, DropdownOptionItem[]>>({});
  const [selectedGroup, setSelectedGroup] = useState<DropdownGroupKey>('task_status');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Add new option
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit inline
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');

  // Migration modal on 409 delete conflict
  const [migrateModal, setMigrateModal] = useState<{
    option: DropdownOptionItem;
    message: string;
    targetId: string;
  } | null>(null);

  // Warehouses, Branches & Operational Hubs state
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [locSearch, setLocSearch] = useState('');
  const [locTypeFilter, setLocTypeFilter] = useState('All');
  const [locModalOpen, setLocModalOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<LocationItem | null>(null);
  const [locCode, setLocCode] = useState('');
  const [locName, setLocName] = useState('');
  const [locType, setLocType] = useState('Warehouse');
  const [locCity, setLocCity] = useState('');
  const [locState, setLocState] = useState('');
  const [locAddress, setLocAddress] = useState('');
  const [locMgr, setLocMgr] = useState('');
  const [locSaving, setLocSaving] = useState(false);
  const [locFormErr, setLocFormErr] = useState('');
  const [deleteLocConfirm, setDeleteLocConfirm] = useState<LocationItem | null>(null);
  const [migrateLocModal, setMigrateLocModal] = useState<{
    location: LocationItem;
    message: string;
    targetId: string;
  } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [ddRes, locRes] = await Promise.all([
        apiFetch<{ groups: GroupMeta[]; optionsByGroup: Record<string, DropdownOptionItem[]> }>(
          '/api/dropdowns?include_inactive=1'
        ),
        apiFetch<{ locations: LocationItem[] }>('/api/locations'),
      ]);
      setGroups(ddRes.groups || []);
      setOptionsByGroup(ddRes.optionsByGroup || {});
      setLocations(locRes.locations || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'dropdowns:updated' || evt.event === 'directory:updated') {
        loadAll();
      }
    });
  }, [subscribeRealtime, loadAll]);

  const currentOptions = optionsByGroup[selectedGroup] || [];
  const currentGroupLabel = groups.find((g) => g.key === selectedGroup)?.label || selectedGroup;
  const locationTypeOptions = getOptions('location_type');

  const filteredLocations = useMemo(() => {
    const q = locSearch.trim().toLowerCase();
    return locations.filter((l) => {
      if (locTypeFilter !== 'All' && l.type !== locTypeFilter) return false;
      if (!q) return true;
      return (
        l.code.toLowerCase().includes(q) ||
        l.name.toLowerCase().includes(q) ||
        l.type.toLowerCase().includes(q) ||
        l.city.toLowerCase().includes(q) ||
        l.state.toLowerCase().includes(q) ||
        (l.manager_name || '').toLowerCase().includes(q) ||
        l.address.toLowerCase().includes(q)
      );
    });
  }, [locations, locSearch, locTypeFilter]);

  const handleAddOption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setError('');
    setNotice('');
    setAdding(true);
    try {
      await apiFetch('/api/dropdowns', {
        method: 'POST',
        body: JSON.stringify({ group_key: selectedGroup, label: newLabel.trim(), is_active: true }),
      });
      setNewLabel('');
      setNotice(`Added "${newLabel.trim()}" to ${currentGroupLabel}.`);
      await Promise.all([loadAll(), refreshDropdowns()]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleSaveEdit = async (opt: DropdownOptionItem) => {
    if (!editLabel.trim()) return;
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/dropdowns/${opt.id}`, {
        method: 'PUT',
        body: JSON.stringify({ label: editLabel.trim() }),
      });
      setEditingId(null);
      setNotice(`Updated "${opt.label}" to "${editLabel.trim()}" across existing records.`);
      await Promise.all([loadAll(), refreshDropdowns()]);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleActive = async (opt: DropdownOptionItem) => {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/dropdowns/${opt.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !opt.is_active }),
      });
      setNotice(`${opt.label} is now ${!opt.is_active ? 'Active' : 'Inactive'}.`);
      await Promise.all([loadAll(), refreshDropdowns()]);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= currentOptions.length) return;
    const reordered = [...currentOptions];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIdx, 0, moved);
    setOptionsByGroup((prev) => ({ ...prev, [selectedGroup]: reordered }));
    try {
      await apiFetch('/api/dropdowns/reorder', {
        method: 'PATCH',
        body: JSON.stringify({
          group_key: selectedGroup,
          ordered_ids: reordered.map((o) => o.id),
        }),
      });
      await refreshDropdowns();
    } catch (err: any) {
      setError(err.message);
      loadAll();
    }
  };

  const handleDelete = async (opt: DropdownOptionItem, migrateToId?: number) => {
    setError('');
    setNotice('');
    try {
      const qs = migrateToId ? `?migrate_to_id=${migrateToId}` : '';
      await apiFetch(`/api/dropdowns/${opt.id}${qs}`, { method: 'DELETE' });
      setMigrateModal(null);
      setNotice(`Deleted "${opt.label}" from ${currentGroupLabel}.`);
      await Promise.all([loadAll(), refreshDropdowns()]);
    } catch (err: any) {
      const msg = err.message || 'Delete failed';
      if (msg.includes('currently used by')) {
        const candidates = currentOptions.filter((c) => c.id !== opt.id);
        setMigrateModal({
          option: opt,
          message: msg,
          targetId: candidates[0] ? String(candidates[0].id) : '',
        });
      } else {
        setError(msg);
      }
    }
  };

  const openCreateLocationModal = () => {
    setEditingLocation(null);
    setLocCode('');
    setLocName('');
    setLocType(locationTypeOptions[0] || 'Warehouse');
    setLocCity('');
    setLocState('');
    setLocAddress('');
    setLocMgr('');
    setLocFormErr('');
    setLocModalOpen(true);
  };

  const openEditLocationModal = (loc: LocationItem) => {
    setEditingLocation(loc);
    setLocCode(loc.code || '');
    setLocName(loc.name || '');
    setLocType(loc.type || 'Warehouse');
    setLocCity(loc.city || '');
    setLocState(loc.state || '');
    setLocAddress(loc.address || '');
    setLocMgr(loc.manager_name || '');
    setLocFormErr('');
    setLocModalOpen(true);
  };

  const handleSaveLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocFormErr('');
    setError('');
    setNotice('');
    setLocSaving(true);
    try {
      const payload = {
        code: locCode.trim(),
        name: locName.trim(),
        type: locType,
        city: locCity.trim(),
        state: locState.trim(),
        address: locAddress.trim(),
        manager_name: locMgr.trim(),
      };
      if (editingLocation) {
        await apiFetch(`/api/locations/${editingLocation.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setNotice(`Updated "${payload.name}" (${payload.code}) across all CRM records.`);
      } else {
        await apiFetch('/api/locations', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setNotice(`Added "${payload.name}" (${payload.code}) to Warehouses, Branches & Operational Hubs.`);
      }
      setLocModalOpen(false);
      setEditingLocation(null);
      await loadAll();
    } catch (err: any) {
      setLocFormErr(err.message || 'Failed to save facility details');
    } finally {
      setLocSaving(false);
    }
  };

  const handleDeleteLocation = async (loc: LocationItem, migrateToId?: number) => {
    setError('');
    setNotice('');
    try {
      const qs = migrateToId ? `?migrate_to_id=${migrateToId}` : '';
      await apiFetch(`/api/locations/${loc.id}${qs}`, { method: 'DELETE' });
      setDeleteLocConfirm(null);
      setMigrateLocModal(null);
      setNotice(`Removed facility "${loc.name}" (${loc.code}).`);
      await loadAll();
    } catch (err: any) {
      const msg = err.message || 'Failed to delete location';
      if (msg.includes('currently linked to')) {
        const candidates = locations.filter((l) => l.id !== loc.id);
        setDeleteLocConfirm(null);
        setMigrateLocModal({
          location: loc,
          message: msg,
          targetId: candidates[0] ? String(candidates[0].id) : '',
        });
      } else {
        setDeleteLocConfirm(null);
        setError(msg);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-display font-semibold text-slate-900 dark:text-white">
            Super Admin Dropdowns & Operational Facilities
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Add, edit, reorder, or safely migrate dropdown categories as well as Warehouses, Branches & Operational Hubs. Changes sync live across all forms and dashboards.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          <button
            type="button"
            onClick={() => {
              setViewMode('dropdowns');
              setError('');
              setNotice('');
            }}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md cursor-pointer ${
              viewMode === 'dropdowns' ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white' : 'text-slate-500'
            }`}
          >
            <ListChecks className="w-3.5 h-3.5" />
            Dropdown Categories
          </button>
          <button
            type="button"
            onClick={() => {
              setViewMode('locations');
              setError('');
              setNotice('');
            }}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md cursor-pointer ${
              viewMode === 'locations' ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white' : 'text-slate-500'
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            Warehouses, Branches & Hubs ({locations.length})
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 text-xs rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {notice && (
        <div className="p-3.5 text-xs rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {viewMode === 'dropdowns' ? (
        <div className="grid lg:grid-cols-12 gap-6">
          {/* Left: Group Selector */}
          <div className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-1 h-fit">
            <div className="px-3 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
              Configurable Dropdown Groups
            </div>
            {groups.map((g) => {
              const count = (optionsByGroup[g.key] || []).length;
              const active = selectedGroup === g.key;
              return (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    setSelectedGroup(g.key);
                    setEditingId(null);
                    setError('');
                    setNotice('');
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium rounded-lg transition-colors cursor-pointer text-left ${
                    active
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <span>{g.label}</span>
                  <span className={`font-mono tabular-nums ${active ? 'text-blue-100' : 'text-slate-400'}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right: Options Manager */}
          <div className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  {currentGroupLabel}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Core system workflow options cannot be deleted to protect workflow integrity, but custom options can be edited or deleted anytime.
                </p>
              </div>
              {selectedGroup === 'location_type' && (
                <button
                  type="button"
                  onClick={() => setViewMode('locations')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 cursor-pointer"
                >
                  <Building2 className="w-3.5 h-3.5" />
                  Edit Warehouses, Branches & Hubs
                </button>
              )}
            </div>

            <form onSubmit={handleAddOption} className="flex flex-wrap gap-2">
              <input
                type="text"
                required
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={`Add new option to ${currentGroupLabel}...`}
                className="flex-1 min-w-[220px] px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <button
                type="submit"
                disabled={adding || !newLabel.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-60 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{adding ? 'Adding...' : 'Add Option'}</span>
              </button>
            </form>

            {loading ? (
              <div className="py-10 text-center text-xs text-slate-500">Loading dropdown options...</div>
            ) : currentOptions.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500">No options configured in this group yet.</div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                {currentOptions.map((opt, idx) => (
                  <div
                    key={opt.id}
                    className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className="text-xs font-mono text-slate-400 w-6 tabular-nums">{idx + 1}.</span>

                      {editingId === opt.id ? (
                        <div className="flex items-center gap-2 flex-1 max-w-sm">
                          <input
                            type="text"
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            className="flex-1 px-2.5 py-1.5 text-sm rounded-lg border border-blue-500 bg-white dark:bg-slate-950"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(opt)}
                            className="p-1.5 rounded bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                            title="Save Rename"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="p-1.5 rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
                            title="Cancel"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900 dark:text-white flex items-center gap-2">
                            <span className={!opt.is_active ? 'line-through text-slate-400' : ''}>{opt.label}</span>
                            {opt.is_system && (
                              <span className="text-[11px] font-medium text-blue-700 dark:text-blue-400">
                                Core Workflow
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {opt.is_active ? 'Active' : 'Inactive'}
                            {' · '}
                            {opt.usage && opt.usage.total > 0
                              ? `Used in ${opt.usage.details.join(', ')}`
                              : 'No records linked yet'}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleMove(idx, -1)}
                        disabled={idx === 0}
                        className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        title="Move Up"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(idx, 1)}
                        disabled={idx === currentOptions.length - 1}
                        className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        title="Move Down"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(opt.id);
                          setEditLabel(opt.label);
                        }}
                        className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        title="Rename Option"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleActive(opt)}
                        className={`px-2.5 py-1 text-xs font-medium rounded border cursor-pointer ${
                          opt.is_active
                            ? 'border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                            : 'border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                        }`}
                      >
                        {opt.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      {!opt.is_system && (
                        <button
                          type="button"
                          onClick={() => handleDelete(opt)}
                          className="p-1.5 rounded border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                          title="Delete Option"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* WAREHOUSES, BRANCHES & OPERATIONAL HUBS MANAGER */
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Building2 className="w-4 h-4 text-blue-600" />
                <span>Warehouses, Branches & Operational Hubs ({filteredLocations.length})</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Add new sites or edit codes, facility names, categories, cities, states, street addresses, and site managers. Updates cascade to linked tickets automatically.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={locSearch}
                  onChange={(e) => setLocSearch(e.target.value)}
                  placeholder="Search code, name, city, manager..."
                  className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <select
                value={locTypeFilter}
                onChange={(e) => setLocTypeFilter(e.target.value)}
                aria-label="Filter by facility type"
                className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="All">All Categories</option>
                {locationTypeOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={openCreateLocationModal}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Warehouse / Branch / Hub
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                  <th className="py-2.5 px-4">Code</th>
                  <th className="py-2.5 px-4">Facility Name</th>
                  <th className="py-2.5 px-4">Category</th>
                  <th className="py-2.5 px-4">City / State</th>
                  <th className="py-2.5 px-4">Site Manager</th>
                  <th className="py-2.5 px-4">Address</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredLocations.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-slate-500">
                      No warehouses, branches, or operational hubs match your filters.
                    </td>
                  </tr>
                ) : (
                  filteredLocations.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-4 font-mono font-semibold whitespace-nowrap">{l.code}</td>
                      <td className="py-2.5 px-4 font-semibold text-slate-900 dark:text-white">{l.name}</td>
                      <td className="py-2.5 px-4 whitespace-nowrap">{l.type}</td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        {l.city}, {l.state}
                      </td>
                      <td className="py-2.5 px-4">{l.manager_name || '—'}</td>
                      <td className="py-2.5 px-4 text-slate-500">{l.address}</td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openEditLocationModal(l)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <Edit3 className="w-3 h-3" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteLocConfirm(l)}
                          aria-label={`Delete ${l.name}`}
                          className="inline-flex items-center p-1.5 rounded border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer align-middle"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Safe Deletion Migration Modal (Dropdowns) */}
      {migrateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Migrate Linked Records Before Deleting
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                  {migrateModal.message}
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5">
                Move existing records to replacement option:
              </label>
              <select
                value={migrateModal.targetId}
                onChange={(e) => setMigrateModal({ ...migrateModal, targetId: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {currentOptions
                  .filter((o) => o.id !== migrateModal.option.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
              </select>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setMigrateModal(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!migrateModal.targetId}
                onClick={() => handleDelete(migrateModal.option, Number(migrateModal.targetId))}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 cursor-pointer"
              >
                Migrate & Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Warehouse, Branch or Hub Modal */}
      {locModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveLocation}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold">
                {editingLocation ? 'Edit Warehouse, Branch or Hub' : 'Add Warehouse, Branch or Hub'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setLocModalOpen(false);
                  setEditingLocation(null);
                }}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {locFormErr && (
              <div className="p-2.5 text-xs rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300">
                {locFormErr}
              </div>
            )}
            <div>
              <label className="block text-xs font-medium mb-1">Location Code *</label>
              <input
                required
                placeholder="e.g. WH-AMD-07"
                value={locCode}
                onChange={(e) => setLocCode(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Facility Name *</label>
              <input
                required
                placeholder="Facility Name"
                value={locName}
                onChange={(e) => setLocName(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Facility Category *</label>
              <select
                value={locType}
                onChange={(e) => setLocType(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {locationTypeOptions.map((t) => (
                  <option key={t} value={t}>
                    {t === 'Hub' ? 'Operational / Logistics Hub' : t}
                  </option>
                ))}
                {locType && !locationTypeOptions.includes(locType) && <option value={locType}>{locType}</option>}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium mb-1">City *</label>
                <input
                  required
                  placeholder="City"
                  value={locCity}
                  onChange={(e) => setLocCity(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">State *</label>
                <input
                  required
                  placeholder="State"
                  value={locState}
                  onChange={(e) => setLocState(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Full Street Address *</label>
              <input
                required
                placeholder="Full Street Address"
                value={locAddress}
                onChange={(e) => setLocAddress(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Site Manager Name</label>
              <input
                placeholder="Site Manager Name"
                value={locMgr}
                onChange={(e) => setLocMgr(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setLocModalOpen(false);
                  setEditingLocation(null);
                }}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={locSaving}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-60 cursor-pointer"
              >
                {locSaving ? 'Saving...' : editingLocation ? 'Save Changes' : 'Save Facility'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Confirm Location Delete Modal */}
      {deleteLocConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Delete "{deleteLocConfirm.name}"?
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                  Are you sure you want to remove facility <span className="font-mono font-semibold">{deleteLocConfirm.code}</span>? If any employees, tickets, assets, or budgets are linked to it, you will be prompted to migrate them safely first.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteLocConfirm(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDeleteLocation(deleteLocConfirm)}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white cursor-pointer"
              >
                Delete Facility
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Safe Location Migration Modal */}
      {migrateLocModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Migrate Linked Records Before Deleting
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                  {migrateLocModal.message}
                </p>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5">
                Move linked records & scopes to replacement Warehouse / Branch / Hub:
              </label>
              <select
                value={migrateLocModal.targetId}
                onChange={(e) => setMigrateLocModal({ ...migrateLocModal, targetId: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {locations
                  .filter((l) => l.id !== migrateLocModal.location.id)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} — {l.name} ({l.city})
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setMigrateLocModal(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!migrateLocModal.targetId}
                onClick={() => handleDeleteLocation(migrateLocModal.location, Number(migrateLocModal.targetId))}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 cursor-pointer"
              >
                Migrate & Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
